import { Injectable, Logger, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
@Injectable()
export class VacancyLifecycleWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(VacancyLifecycleWorker.name);
  private timer?: NodeJS.Timeout;
  private busy = false;
  private activated = false;
  constructor(private readonly db: SupabaseService) {}
  onModuleInit() {
    if (!this.db.isEnabled()) return;
    this.timer = setInterval(() => void this.tick(), 60000);
    this.timer.unref();
    void this.tick();
  }
  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.activated) {
        const activation = await this.db.client.rpc('activate_vacancy_lifecycle');
        if (activation.error) throw activation.error;
        this.activated = true;
      }
      const { error } = await this.db.client.rpc('run_vacancy_lifecycle');
      if (error) throw error;
      const q = await this.db.client.from('job_media_cleanup').select('path').limit(20);
      if (q.error) throw q.error;
      for (const row of q.data ?? []) {
        const result = await this.db.client.storage.from('job-business-photos').remove([row.path]);
        if (!result.error) {
          const removed = await this.db.client
            .from('job_media_cleanup')
            .delete()
            .eq('path', row.path);
          if (removed.error) throw removed.error;
        }
      }
    } catch {
      this.logger.warn('Vacancy lifecycle tick failed; next tick will retry');
    } finally {
      this.busy = false;
    }
  }
}
