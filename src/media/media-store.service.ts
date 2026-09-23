import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class MediaStoreService implements OnModuleInit {
  private readonly logger = new Logger(MediaStoreService.name);
  private readonly bucket: string;
  private readonly localRoot = resolve(process.cwd(), 'data/media');

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {
    this.bucket = this.config.get<string>('SUPABASE_BUCKET') ?? 'adyarat-media';
  }

  async onModuleInit(): Promise<void> {
    if (!this.supabase.isEnabled()) {
      await mkdir(this.localRoot, { recursive: true });
      return;
    }

    try {
      const { data, error } = await this.supabase.client.storage.listBuckets();
      if (error) throw error;
      if (!data.some((bucket) => bucket.id === this.bucket)) {
        const { error: createError } = await this.supabase.client.storage.createBucket(
          this.bucket,
          {
            public: false,
            fileSizeLimit: 50 * 1024 * 1024,
            allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'],
          },
        );
        if (createError) throw createError;
        this.logger.log(`Created private storage bucket: ${this.bucket}`);
      }
    } catch (error) {
      this.logger.error('Could not verify Supabase storage bucket', error);
      throw error;
    }
  }

  mode(): 'supabase' | 'local' {
    return this.supabase.isEnabled() ? 'supabase' : 'local';
  }

  async put(path: string, bytes: Buffer, contentType: string): Promise<string> {
    const normalized = this.normalizePath(path);
    if (this.supabase.isEnabled()) {
      const { error } = await this.supabase.client.storage
        .from(this.bucket)
        .upload(normalized, bytes, { contentType, upsert: false });
      if (error) throw error;
      return normalized;
    }

    const target = this.resolveLocalPath(normalized);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
    return normalized;
  }

  async get(path: string): Promise<Buffer> {
    const normalized = this.normalizePath(path);
    if (this.supabase.isEnabled()) {
      const { data, error } = await this.supabase.client.storage
        .from(this.bucket)
        .download(normalized);
      if (error) throw error;
      return Buffer.from(await data.arrayBuffer());
    }
    return readFile(this.resolveLocalPath(normalized));
  }

  private normalizePath(path: string): string {
    return path.replaceAll('\\', '/').replace(/^\/+/, '');
  }

  private resolveLocalPath(path: string): string {
    const target = resolve(this.localRoot, path);
    if (target !== this.localRoot && !target.startsWith(`${this.localRoot}${sep}`)) {
      throw new Error('Invalid media path');
    }
    return target;
  }
}
