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
import { join } from 'node:path';
import { spawn } from 'node:child_process';

@Injectable()
export class AudioComposerService {
  private readonly logger = new Logger(
    AudioComposerService.name,
  );

  async concatenate(
    audioParts: Buffer[],
  ): Promise<Buffer> {
    if (audioParts.length === 0) {
      throw new Error(
        'Birləşdirmək üçün audio hissəsi yoxdur.',
      );
    }

    if (audioParts.length === 1) {
      return audioParts[0];
    }

    const workDirectory =
      await mkdtemp(
        join(
          tmpdir(),
          'adyarat-audio-',
        ),
      );

    try {
      const audioPaths: string[] = [];

      for (
        let index = 0;
        index < audioParts.length;
        index += 1
      ) {
        const filePath = join(
          workDirectory,
          `part-${index + 1}.mp3`,
        );

        await writeFile(
          filePath,
          audioParts[index],
        );

        audioPaths.push(filePath);
      }

      const listPath = join(
        workDirectory,
        'audio-list.txt',
      );

      const listContent =
        audioPaths
          .map((filePath) => {
            const escaped =
              filePath.replace(
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
        'final-audio.mp3',
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
          outputPath,
        ]);
      } catch {
        this.logger.warn(
          'Direct audio concat failed. Re-encoding audio.',
        );

        await this.runFfmpeg([
          '-y',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          listPath,
          '-c:a',
          'libmp3lame',
          '-b:a',
          '192k',
          outputPath,
        ]);
      }

      return await readFile(
        outputPath,
      );
    } finally {
      await rm(
        workDirectory,
        {
          recursive: true,
          force: true,
        },
      );
    }
  }

  private runFfmpeg(
    args: string[],
  ): Promise<void> {
    return new Promise(
      (resolve, reject) => {
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
            stderr +=
              chunk.toString();
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
                  `FFmpeg audio xətası. Exit code: ${code}`,
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
