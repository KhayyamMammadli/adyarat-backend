import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AdminActor } from './telegram.types';

export type AdminSession = {
  kind: 'idle' | 'create' | 'reject' | 'business_verify';
  nonce?: string;
  step?: string;
  draft?: Record<string, any>;
  jobId?: number;
  businessId?: string;
  registrationToken?: string;
  moderationMessageId?: number;
  promptMessageId?: number;
  lastUpdateId: number;
  expiresAt?: string;
};
export type AdminState = {
  profileId: string;
  metadata: Record<string, any>;
  updatedAt?: string;
  session: AdminSession;
};

@Injectable()
export class TelegramAdminStateService {
  constructor(private readonly supabase: SupabaseService) {}

  async load(actor: AdminActor): Promise<AdminState> {
    // Namespaced identities isolate Telegram state from real WhatsApp phone/BSUID profiles.
    const profile = await this.supabase.client
      .from('job_agent_profiles')
      .upsert(
        {
          wa_id: `telegram-admin:${actor.chatId}:${actor.userId}`,
          display_name: 'Telegram admin',
          role: 'employer',
        },
        { onConflict: 'wa_id' },
      )
      .select('id')
      .single();
    if (profile.error) throw profile.error;
    let employer = await this.supabase.client
      .from('employer_profiles')
      .select('*')
      .eq('profile_id', profile.data.id)
      .maybeSingle();
    if (employer.error) throw employer.error;
    if (!employer.data) {
      const result = await this.supabase.client
        .from('employer_profiles')
        .upsert(
          { profile_id: profile.data.id },
          { onConflict: 'profile_id', ignoreDuplicates: true },
        );
      if (result.error) throw result.error;
      employer = await this.supabase.client
        .from('employer_profiles')
        .select('*')
        .eq('profile_id', profile.data.id)
        .single();
      if (employer.error) throw employer.error;
    }
    const metadata = employer.data.metadata ?? {};
    return {
      profileId: profile.data.id,
      metadata,
      updatedAt: employer.data.updated_at,
      session: metadata.telegram_admin_session ?? { kind: 'idle', lastUpdateId: -1 },
    };
  }

  async save(state: AdminState, session: AdminSession): Promise<void> {
    let query = this.supabase.client
      .from('employer_profiles')
      .update({
        metadata: { ...state.metadata, telegram_admin_session: session },
        updated_at: new Date().toISOString(),
      })
      .eq('profile_id', state.profileId);
    // Optimistic comparison keeps a second instance/replayed update from overwriting a newer step.
    if (state.metadata.telegram_admin_session)
      query = query.contains('metadata', {
        telegram_admin_session: state.metadata.telegram_admin_session,
      });
    else if (state.updatedAt) query = query.eq('updated_at', state.updatedAt);
    const { error } = await query.select('profile_id').single();
    if (error) throw error;
  }
}
