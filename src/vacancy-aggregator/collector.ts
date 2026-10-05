import { Logger } from '@nestjs/common';
import { SourceAdapter } from './types';
import { NormalizedVacancy } from './types';
import { VacancyNormalizer } from './normalization';
import { CollectorRepository } from './repository';
import { bounded, SourceAccessError } from './http';

export class VacancyCollector {
  private readonly logger = new Logger(VacancyCollector.name);
  constructor(
    private readonly sources: SourceAdapter[],
    private readonly normalizer: VacancyNormalizer,
    private readonly repository: CollectorRepository,
    private readonly timeoutMs = 30000,
    private readonly notifyPending?: (id: number, job: NormalizedVacancy) => Promise<void>,
  ) {}

  async run(): Promise<
    Array<{ source: string; status: string; inserted: number; duplicates: number; invalid: number }>
  > {
    const reports = [];
    for (const source of this.sources) {
      const report = {
        source: source.source,
        status: 'ok',
        inserted: 0,
        duplicates: 0,
        invalid: 0,
      };
      if (!source.enabled) {
        report.status = 'disabled';
        reports.push(report);
        this.logger.log(`${source.source}: disabled (${source.disabledReason ?? 'unconfigured'})`);
        continue;
      }
      try {
        let records;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            records = await bounded((signal) => source.collect(signal), this.timeoutMs);
            break;
          } catch (error) {
            if (error instanceof SourceAccessError || attempt === 1) throw error;
            this.logger.warn(`${source.source}: transient failure; retrying once`);
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
        for (const raw of (records ?? []).slice(0, 50)) {
          let job;
          try {
            job = await bounded(
              (signal) => this.normalizer.normalize(source.source, raw, signal),
              10000,
            );
          } catch {
            report.invalid++;
            this.logger.warn(`${source.source}: invalid item skipped`);
            continue;
          }
          try {
            const result = await this.repository.insert(job);
            if (result.inserted) {
              report.inserted++;
              if (job.status === 'pending' && this.notifyPending) {
                try {
                  await this.notifyPending(result.id, job);
                } catch {
                  this.logger.warn(`${source.source}: admin notice failed; retrieve via /pending`);
                }
              }
            } else report.duplicates++;
          } catch {
            report.invalid++;
            report.status = 'partial';
            this.logger.warn(`${source.source}: item persistence failed`);
          }
        }
        this.logger.log(`${source.source}: ${JSON.stringify(report)}`);
      } catch {
        report.status = 'failed';
        this.logger.warn(`${source.source}: failed; continuing with other sources`);
      }
      reports.push(report);
    }
    return reports;
  }
}
