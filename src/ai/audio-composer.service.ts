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

import {
  tmpdir,
} from 'node:os';

import {
  join,
} from 'node:path';

import {
  spawn,
} from 'node:child_process';

@Injectable()
export class AudioComposerService {
  private readonly logger =
    new Logger(
      AudioComposerService.name,
    );

  async concatenate(
    audioParts: Buffer[],
  ): Promise<Buffer> {
    if (!audioParts.length) {
      throw new Error(
        'Birləşdiriləcək audio hissəsi yoxdur.',
      );
    }

    if (audioParts.length === 1) {
      return audioParts[0];
    }

    const directory =
      await mkdtemp(
        join(
          tmpdir(),
          'adyarat-audio-',
        ),
      );

    try {
      const inputFiles: string[] = [];

      for (
        let index = 0;
        index < audioParts.length;
        index += 1
      ) {
        const filename =
          join(
            directory,
            `part-${index + 1}.mp3`,
          );

        await writeFile(
          filename,
          audioParts[index],
        );

        inputFiles.push(filename);
      }

      const concatFile =
        join(
          directory,
          'inputs.txt',
        );

      const concatContent =
        inputFiles
          .map(
            (file) =>
              `file '${file.replace(/'/g, "'\\''")}'`,
          )
          .join('\n');

      await writeFile(
        concatFile,
        concatContent,
        'utf8',
      );

      const outputFile =
        join(
          directory,
          'output.mp3',
        );

      await this.runFfmpeg([
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatFile,
        '-c:a',
        'libmp3lame',
        '-b:a',
        '192k',
        outputFile,
      ]);

      return await readFile(
        outputFile,
      );
    } finally {
      await rm(
        directory,
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
      (
        resolve,
        reject,
      ) => {
        const process =
          spawn(
            'ffmpeg',
            args,
          );

        let stderr = '';

        process.stderr.on(
          'data',
          (chunk) => {
            stderr +=
              chunk.toString();
          },
        );

        process.on(
          'error',
          (error) => {
            reject(error);
          },
        );

        process.on(
          'close',
          (code) => {
            if (code === 0) {
              resolve();
              return;
            }

            this.logger.error(
              stderr,
            );

            reject(
              new Error(
                `FFmpeg audio composition failed with code ${code}`,
              ),
            );
          },
        );
      },
    );
  }
}