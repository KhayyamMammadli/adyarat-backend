import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Contact,
  GenerationJob,
} from '../common/domain';
import {
  errorMessage,
  ExternalServiceError,
} from '../common/errors';
import { MediaStoreService } from '../media/media-store.service';
import { DataStoreService } from '../supabase/data-store.service';
import { WhatsAppClientService } from '../whatsapp/whatsapp-client.service';
import { VideoComposerService } from './video-composer.service';
import { VideoProviderService } from './video-provider.service';

@Injectable()
export class GenerationWorkerService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(
    GenerationWorkerService.name,
  );

  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly config: ConfigService,
    private readonly dataStore: DataStoreService,
    private readonly mediaStore: MediaStoreService,
    private readonly whatsapp: WhatsAppClientService,
    private readonly provider: VideoProviderService,
    private readonly composer: VideoComposerService,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>(
        'GENERATION_POLL_MS',
      ) ?? 3000;

    void this.safeTick();

    this.timer = setInterval(
      () => void this.safeTick(),
      interval,
    );

    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async tick(): Promise<void> {
    if (this.busy) {
      return;
    }

    this.busy = true;

    try {
      await this.recoverStaleJobs();

      const job =
        await this.dataStore.claimNextJob();

      if (!job) {
        return;
      }

      const contact =
        await this.dataStore.getContactById(
          job.contactId,
        );

      if (!contact) {
        await this.dataStore.updateJob(
          job.id,
          {
            status: 'failed',
            stage: 'failed',
            errorMessage:
              'Contact not found',
          },
        );

        return;
      }

      try {
         if (
              job.videoMode === 'long' ||
              (job.targetDurationSeconds ?? 10) > 10
            ) {
          await this.processLongVideo(
            job,
            contact,
          );

          return;
        }

        await this.processSingleVideo(
          job,
          contact,
        );
      } catch (error) {
        await this.handleGenerationFailure(
          job,
          contact,
          error,
        );
      }
    } finally {
      this.busy = false;
    }
  }

  private async processSingleVideo(
    job: GenerationJob,
    contact: Contact,
  ): Promise<void> {
    const image =
      await this.mediaStore.get(
        job.inputStoragePath,
      );

    const result =
      await this.provider.generate({
        image,
        imageMimeType:
          job.inputMimeType,
        prompt:
          job.prompt,
      });

    const outputPath =
      `outputs/${contact.waId}/` +
      `${job.id}.mp4`;

    await this.mediaStore.put(
      outputPath,
      result.bytes,
      result.mimeType,
    );

    await this.sendCompletedVideo(
      job,
      contact,
      result.bytes,
      outputPath,
      result.providerJobId,
    );
  }

  private async processLongVideo(
    job: GenerationJob,
    contact: Contact,
  ): Promise<void> {
   const sceneCount =
  job.sceneCount ??
  Math.max(
    1,
    Math.ceil(
      (job.targetDurationSeconds ?? 10) / 10,
    ),
  );

    await this.dataStore.updateJob(
      job.id,
      {
        stage: 'generating_scenes',
        progressCompleted: 0,
        progressTotal:
          sceneCount,
      },
    );

    const sourcePaths =
      job.sourceImagePaths?.length
        ? job.sourceImagePaths
        : [job.inputStoragePath];

    const sourceMimes =
      job.sourceImageMimes?.length
        ? job.sourceImageMimes
        : [job.inputMimeType];

    const clips: {
      bytes: Buffer;
      filename: string;
    }[] = [];

    let lastProviderJobId:
      | string
      | undefined;

    for (
      let index = 0;
      index < sceneCount;
      index += 1
    ) {
      const imageIndex =
        index %
        sourcePaths.length;

      const imagePath =
        sourcePaths[imageIndex] ??
        job.inputStoragePath;

      const imageMime =
        sourceMimes[imageIndex] ??
        job.inputMimeType;

      const image =
        await this.mediaStore.get(
          imagePath,
        );

      const plannedScene =
        job.scenePlan?.find(
          (scene) =>
            scene.sceneIndex ===
            index,
        );

     const scenePrompt =
        plannedScene?.prompt ??
        this.buildScenePrompt(
          job.prompt,
          index,
          sceneCount,
        );

      private buildScenePrompt(
  basePrompt: string,
  sceneIndex: number,
  sceneCount: number,
): string {
  const sceneDirections = [
    'Cinematic establishing shot. Introduce the product or business and its environment. Smooth camera movement, premium commercial look.',

    'Medium shot focused on the product being used naturally. Show the main action clearly. Dynamic but elegant camera movement.',

    'Extreme close-up product detail shot. Highlight texture, material, steam, light reflections or important visual details.',

    'Lifestyle scene with a person naturally interacting with the product. Authentic emotion, premium advertising style.',

    'Show the main benefit of the product visually. Make the advantage easy to understand without relying on text.',

    'Hero product shot. Product centered beautifully with cinematic lighting, shallow depth of field and premium composition.',

    'Different camera angle and location while keeping the same visual identity. Add visual variety to the commercial.',

    'Slow cinematic tracking shot. Show the product in motion or demonstrate how it works.',

    'Emotional lifestyle moment connected to the product. Natural human reaction and visually attractive environment.',

    'Macro detail shot with dramatic lighting. Focus on the strongest visual feature of the product.',

    'Wide cinematic scene showing the product in its real environment. Professional commercial photography style.',

    'Dynamic advertising scene. Faster camera movement while preserving premium cinematic quality.',

    'Show another important use case or benefit of the product. Make this scene clearly different from previous scenes.',

    'Elegant close-up with slow camera push-in. Premium lighting and strong visual focus on the brand or product.',

    'Lifestyle scene from a new perspective. Natural movement, realistic environment and commercial quality.',

    'Final product showcase. Make the product look desirable, polished and premium.',

    'Brand-focused closing scene. Leave clean visual space where a logo or call-to-action could later be added.',

    'Strong cinematic ending shot. Product hero composition, memorable lighting and polished commercial finish.',
  ];

  const direction =
    sceneDirections[
      sceneIndex %
        sceneDirections.length
    ];

  return [
    basePrompt,
    '',
    `Scene ${sceneIndex + 1} of ${sceneCount}.`,
    direction,
    '',
    'IMPORTANT:',
    'This scene must look visually different from the previous scenes.',
    'Keep the same product identity and overall advertising style.',
    'Do not add random text, logos or watermarks.',
    'Create a professional cinematic advertisement.',
  ].join('\n');
}

      this.logger.log(
        `Generating scene ${index + 1}/${sceneCount} ` +
          `for job ${job.id}`,
      );

      const result =
        await this.provider.generate({
          image,
          imageMimeType:
            imageMime,
          prompt:
            scenePrompt,
        });

      lastProviderJobId =
        result.providerJobId ??
        lastProviderJobId;

      const scenePath =
        `outputs/${contact.waId}/` +
        `${job.id}/scene-${index + 1}.mp4`;

      await this.mediaStore.put(
        scenePath,
        result.bytes,
        result.mimeType,
      );

      clips.push({
        bytes: result.bytes,
        filename:
          `scene-${index + 1}.mp4`,
      });

      await this.dataStore.updateJob(
        job.id,
        {
          progressCompleted:
            index + 1,
          progressTotal:
            sceneCount,
        },
      );
    }

    await this.dataStore.updateJob(
      job.id,
      {
        stage: 'composing',
      },
    );

    this.logger.log(
      `Composing ${clips.length} scenes ` +
        `for job ${job.id}`,
    );

    const finalVideo =
      await this.composer.concatenate(
        clips,
      );

    const outputPath =
      `outputs/${contact.waId}/` +
      `${job.id}-final.mp4`;

    await this.mediaStore.put(
      outputPath,
      finalVideo.bytes,
      finalVideo.mimeType,
    );

    await this.sendCompletedVideo(
      job,
      contact,
      finalVideo.bytes,
      outputPath,
      lastProviderJobId,
    );
  }

  private async sendCompletedVideo(
    job: GenerationJob,
    contact: Contact,
    bytes: Buffer,
    outputPath: string,
    providerJobId?: string,
  ): Promise<void> {
    const targetDuration =
      job.targetDurationSeconds ?? 10;
    
    const isLongVideo =
      job.videoMode === 'long' ||
      targetDuration > 10;

    const messageId =
      await this.whatsapp.sendVideo(
        contact.waId,
        bytes,
        [
         isLongVideo
            ? `${targetDuration} saniyəlik videonuz hazırdır 🎬`
            : '10 saniyəlik videonuz hazırdır 🎬',
          'AdYarat ilə hazırlanıb.',
        ].join('\n'),
      );

    await this.dataStore.recordMessage({
      waMessageId: messageId,
      contactId:
        contact.id,
      direction:
        'outbound',
      type: 'video',
      content: {
        jobId: job.id,
        storagePath:
          outputPath,
        videoMode:
          job.videoMode ??
          'single',
        targetDurationSeconds:
          job.targetDurationSeconds ??
          10,
      },
      status: 'sent',
    });

    await this.dataStore.updateJob(
      job.id,
      {
        status: 'completed',
        stage: 'completed',
        progressCompleted:
          job.sceneCount ?? 1,
        progressTotal:
          job.sceneCount ?? 1,
        outputStoragePath:
          outputPath,
        providerJobId,
        errorMessage:
          undefined,
        errorCode:
          undefined,
      },
    );

    await this.dataStore.updateContact(
      contact.id,
      {
        state: 'new',

        ...(contact.freeVideoUsed ===
        false
          ? {
              freeVideoUsed: true,
            }
          : {}),

        pendingImagePath:
          undefined,

        pendingImageMime:
          undefined,

        pendingImagePaths: [],

        pendingImageMimes: [],
      },
    );

    await this.sendQuickActions(
      contact.id,
      contact.waId,
    );
  }

  private async safeTick(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      this.logger.error(
        `Generation worker tick failed: ${errorMessage(error)}`,
      );
    }
  }

  private async handleGenerationFailure(
    job: GenerationJob,
    contact: Contact,
    error: unknown,
  ): Promise<void> {
    const message =
      errorMessage(error);

    this.logger.error(
      `Generation job ${job.id} failed: ${message}`,
    );

    try {
      await this.dataStore.updateJob(
        job.id,
        {
          status: 'failed',
          stage: 'failed',
          errorMessage:
            message.slice(
              0,
              2000,
            ),
        },
      );
    } catch (updateError) {
      this.logger.error(
        `Could not mark generation job ` +
          `${job.id} as failed: ` +
          errorMessage(
            updateError,
          ),
      );
    }

    try {
      await this.dataStore.updateContact(
        contact.id,
        {
          state:
            'awaiting_prompt',
        },
      );
    } catch (updateError) {
      this.logger.error(
        `Could not reset contact ` +
          `${contact.id} after generation failure: ` +
          errorMessage(
            updateError,
          ),
      );
    }

    await this.sendFailureMessage(
      contact.id,
      contact.waId,
      this.publicFailureMessage(
        error,
      ),
    );
  }

  private publicFailureMessage(
    error: unknown,
  ): string {
    if (
      error instanceof
      ExternalServiceError
    ) {
      if (
        error.code ===
        'insufficient_credits'
      ) {
        return [
          'Video hazırlana bilmədi ❌',
          'Video xidməti hazırda müvəqqəti əlçatan deyil.',
          'Bir neçə dəqiqə sonra yenidən yoxlayın.',
          'Şəkliniz saxlanılıb; yalnız təsviri yenidən göndərməyiniz kifayətdir.',
        ].join('\n');
      }

      if (
        error.code ===
        'invalid_request'
      ) {
        return [
          'Video hazırlana bilmədi ❌',
          'Şəkil və ya yazdığınız təsvir video xidməti tərəfindən qəbul edilmədi.',
          'Başqa şəkil və ya daha sadə təsvirlə yenidən yoxlayın.',
        ].join('\n');
      }

      if (
        error.code ===
        'rate_limited'
      ) {
        return [
          'Video hazırlana bilmədi ❌',
          'Video xidməti hazırda çox yüklənib. Bir neçə dəqiqə sonra yenidən yoxlayın.',
        ].join('\n');
      }
    }

    return [
      'Video hazırlanarkən texniki xəta baş verdi ❌',
      'Sorğu dayandırıldı. Şəkliniz saxlanılıb; bir az sonra təsviri yenidən göndərə bilərsiniz.',
    ].join('\n');
  }

  private async sendFailureMessage(
    contactId: string,
    waId: string,
    text: string,
  ): Promise<void> {
    try {
      const messageId =
        await this.whatsapp.sendText(
          waId,
          text,
        );

      try {
        await this.dataStore.recordMessage({
          waMessageId:
            messageId,
          contactId,
          direction:
            'outbound',
          type: 'text',
          content: {
            text,
            event:
              'video-generation-failed',
          },
          status: 'sent',
        });
      } catch (error) {
        this.logger.error(
          'Failure message was sent but could not be recorded: ' +
            errorMessage(error),
        );
      }
    } catch (error) {
      this.logger.error(
        `Could not send failure message: ${errorMessage(error)}`,
      );
    }

    await this.sendQuickActions(
      contactId,
      waId,
    );
  }

  private async recoverStaleJobs(): Promise<void> {
    const staleMs =
      this.config.get<number>(
        'GENERATION_STALE_MS',
      ) ??
      20 * 60 * 1000;

    const updatedBefore =
      new Date(
        Date.now() - staleMs,
      ).toISOString();

    const staleJobs =
      await this.dataStore.getStaleProcessingJobs(
        updatedBefore,
      );

    for (
      const job of staleJobs
    ) {
      const contact =
        await this.dataStore.getContactById(
          job.contactId,
        );

      await this.dataStore.updateJob(
        job.id,
        {
          status: 'failed',
          stage: 'failed',
          errorMessage:
            'Generation timed out or worker restarted',
        },
      );

      if (!contact) {
        continue;
      }

      await this.dataStore.updateContact(
        contact.id,
        {
          state:
            'awaiting_prompt',
        },
      );

      await this.sendFailureMessage(
        contact.id,
        contact.waId,
        [
          'Video sorğusunun emal müddəti bitdi ❌',
          'Sorğu dayandırıldı. Şəkliniz saxlanılıb; təsviri yenidən göndərə bilərsiniz.',
        ].join('\n'),
      );
    }
  }

  private async sendQuickActions(
    contactId: string,
    waId: string,
  ): Promise<void> {
    try {
      const messageId =
        await this.whatsapp.sendQuickActions(
          waId,
        );

      await this.dataStore.recordMessage({
        waMessageId:
          messageId,
        contactId,
        direction:
          'outbound',
        type:
          'interactive',
        content: {
          menu:
            'quick-actions',
        },
        status:
          'sent',
      });
    } catch (error) {
      this.logger.warn(
        `Could not send quick actions: ${errorMessage(error)}`,
      );
    }
  }
}
