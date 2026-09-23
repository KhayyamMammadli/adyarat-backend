import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService {
  private readonly logger = new Logger(SupabaseService.name);
  private readonly supabase?: SupabaseClient;

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string>('SUPABASE_URL');
    const key =
      this.config.get<string>('SUPABASE_SECRET_KEY') ??
      this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');

    if (url && key) {
      this.supabase = createClient(url, key, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      });
      this.logger.log('Supabase persistence enabled');
    } else {
      this.logger.warn('Supabase is not configured; using in-memory persistence');
    }
  }

  isEnabled(): boolean {
    return Boolean(this.supabase);
  }

  get client(): SupabaseClient {
    if (!this.supabase) {
      throw new Error('Supabase is not configured');
    }
    return this.supabase;
  }
}
