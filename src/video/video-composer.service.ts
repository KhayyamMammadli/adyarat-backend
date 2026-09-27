import {
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  basename,
  join,
} from 'node:path';
import { spawn } from 'node:child_process';

export interface VideoClipInput {
  bytes: Buffer;
  filename?: string;
}

export interface VideoCompositionResult {
  bytes: Buffer;
  mimeType: 'video/mp4';
}

@Injectable()
export class VideoComposerService {
  private readonly logger = new Logger(
    VideoComposerService.name,
  );

  async concatenate(
    clips: VideoClipInput[],
  ): Promise<VideoCompositionResult> {
    if (clips.length === 0) {
      throw new Error(
        'Birləşdirmək üçün ən azı 1 video lazımdır.',
      );
    }

    const workDirectory = await mkdtemp(
      join(tmpdir(), 'adyarat-video-'),
    );

    try {
      const clipPaths: string[] = [];

      for (
        let index = 0;
        index < clips.length;
        index += 1
      ) {
        const clip = clips[index];

        const filename =
          clip.filename?.trim() ||
          `scene-${index + 1}.mp4`;

        const safeFilename =
          basename(filename);

        const inputPath = join(
          workDirectory,
          safeFilename,
        );

        await writeFile(
          inputPath,
          clip.bytes,
        );

        clipPaths.push(inputPath);
      }

      const listPath = join(
        workDirectory,
        'videos.txt',
      );

      const listContent = clipPaths
        .map((filePath) => {
          const escaped = filePath.replace(
            /'/g,
            `'\\''`,
          );

          return `file '${escaped}'`;
        })
        .join('\n');

      await writeFile(
        listPath,
        listContent,
        'utf8',
      );

      const outputPath = join(
        workDirectory,
        'final-video.mp4',
      );

      try {
        await this.runFfmpeg([
          '-y',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          listPath,
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          outputPath,
        ]);
      } catch (error) {
        this.logger.warn(
          'Direct concat failed. Falling back to re-encoding.',
        );

        await this.runReencodeConcat(
          clipPaths,
          outputPath,
        );
      }

      const bytes = await readFile(
        outputPath,
      );

      return {
        bytes,
        mimeType: 'video/mp4',
      };
    } finally {
      await rm(workDirectory, {
        recursive: true,
        force: true,
      });
    }
  }

  private async runReencodeConcat(
    clipPaths: string[],
    outputPath: string,
  ): Promise<void> {
    const args: string[] = [
      '-y',
    ];

    for (const clipPath of clipPaths) {
      args.push(
        '-i',
        clipPath,
      );
    }

    const videoStreams = clipPaths
      .map(
        (_, index) =>
          `[${index}:v:0]`,
      )
      .join('');

    const audioStreams = clipPaths
      .map(
        (_, index) =>
          `[${index}:a:0]`,
      )
      .join('');

    const filterComplex = [
      `${videoStreams}concat=n=${clipPaths.length}:v=1:a=0[outv]`,
      `${audioStreams}concat=n=${clipPaths.length}:v=0:a=1[outa]`,
    ].join(';');

    try {
      await this.runFfmpeg([
        ...args,
        '-filter_complex',
        filterComplex,
        '-map',
        '[outv]',
        '-map',
        '[outa]',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        outputPath,
      ]);
    } catch {
      await this.runVideoOnlyConcat(
        clipPaths,
        outputPath,
      );
    }
  }

  private async runVideoOnlyConcat(
    clipPaths: string[],
    outputPath: string,
  ): Promise<void> {
    const args: string[] = [
      '-y',
    ];

    for (const clipPath of clipPaths) {
      args.push(
        '-i',
        clipPath,
      );
    }

    const videoStreams = clipPaths
      .map(
        (_, index) =>
          `[${index}:v:0]`,
      )
      .join('');

    const filterComplex =
      `${videoStreams}` +
      `concat=n=${clipPaths.length}:v=1:a=0[outv]`;

    await this.runFfmpeg([
      ...args,
      '-filter_complex',
      filterComplex,
      '-map',
      '[outv]',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      outputPath,
    ]);
  }

  private runFfmpeg(
    args: string[],
  ): Promise<void> {
    return new Promise(
      (resolve, reject) => {
        this.logger.debug(
          `Running ffmpeg ${args.join(' ')}`,
        );

        const process = spawn(
          'ffmpeg',
          args,
          {
            stdio: [
              'ignore',
              'pipe',
              'pipe',
            ],
          },
        );

        let stderr = '';

        process.stderr.on(
          'data',
          (chunk: Buffer) => {
            stderr += chunk.toString();
          },
        );

        process.on(
          'error',
          (error) => {
            reject(
              new Error(
                `FFmpeg başladılmadı: ${error.message}`,
              ),
            );
          },
        );

        process.on(
          'close',
          (code) => {
            if (code === 0) {
              resolve();
              return;
            }

            reject(
              new Error(
                [
                  `FFmpeg xətası. Exit code: ${code}`,
                  stderr.slice(-3000),
                ].join('\n'),
              ),
            );
          },
        );
      },
    );
  }
}
