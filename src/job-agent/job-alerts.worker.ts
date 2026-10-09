import { Injectable, Logger, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalServiceError } from '../common/errors';
import { SupabaseService } from '../supabase/supabase.service';
import { WhatsAppClientService } from '../whatsapp/whatsapp-client.service';
@Injectable()
export class JobAlertsWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(JobAlertsWorker.name);
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(
    private readonly db: SupabaseService,
    private readonly wa: WhatsAppClientService,
    private readonly config: ConfigService,
  ) {}
  onModuleInit() {
    if (!this.db.isEnabled() || this.config.get('JOB_ALERTS_ENABLED') !== 'true') return;
    if (
      !this.config.get('JOB_ALERT_TEMPLATE_NAME') ||
      !this.config.get('JOB_ALERT_TEMPLATE_LANGUAGE')
    ) {
      this.logger.warn('Job alerts need an approved WhatsApp template and language');
      return;
    }
    this.timer = setInterval(() => void this.tick(), 10000);
    this.timer.unref();
    void this.tick();
  }
  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }
  async tick() {
    if (
      this.busy ||
      this.config.get('JOB_ALERTS_ENABLED') !== 'true' ||
      !this.config.get('JOB_ALERT_TEMPLATE_NAME') ||
      !this.config.get('JOB_ALERT_TEMPLATE_LANGUAGE')
    )
      return;
    this.busy = true;
    try {
      const r = await this.db.client.rpc('claim_job_alert_deliveries');
      if (r.error) throw r.error;
      for (const row of r.data ?? []) {
        const target = await this.db.client.rpc('job_alert_delivery_target', {
          p_delivery: row.id,
        });
        if (target.error) throw target.error;
        if (!target.data) {
          await this.finish(row.id, 'cancelled');
          continue;
        }
        const j = target.data.job;
        let messageId: string;
        try {
          messageId = await this.wa.sendJobAlertTemplate(target.data.wa_id, j);
        } catch (error) {
          // Only explicit API rejection is safe to retry. Timeouts/5xx may have accepted the send.
          const rejected =
            error instanceof ExternalServiceError &&
            error.status != null &&
            error.status >= 400 &&
            error.status < 500;
          await this.finish(
            row.id,
            rejected ? 'failed' : 'unknown',
            undefined,
            rejected ? `Meta HTTP ${error.status}` : 'Send outcome unconfirmed',
          );
          continue;
        }
        // Never retry a successful send if recording its acknowledgement fails.
        await this.finish(row.id, 'sent', messageId);
      }
    } catch {
      this.logger.warn('Job alert worker could not complete tick; persisted queue is retained');
    } finally {
      this.busy = false;
    }
  }
  private async finish(id: number, status: string, message_id?: string, last_error?: string) {
    const r = await this.db.client
      .from('job_alert_deliveries')
      .update({
        status,
        message_id: message_id ?? null,
        last_error: last_error ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('status', 'sending');
    if (r.error) throw r.error;
  }
}
