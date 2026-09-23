import { Global, Module } from '@nestjs/common';
import { DataStoreService } from './data-store.service';
import { SupabaseService } from './supabase.service';

@Global()
@Module({
  providers: [SupabaseService, DataStoreService],
  exports: [SupabaseService, DataStoreService],
})
export class SupabaseModule {}
