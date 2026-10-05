import { InlineKeyboard } from './telegram.types';

export function moderationButtons(jobId: number): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: '✅ Təsdiq et', callback_data: `tg:approve:${jobId}` },
        { text: '❌ Rədd et', callback_data: `tg:reject:${jobId}` },
      ],
    ],
  };
}

export function formatTelegramJob(job: Record<string, any>): string {
  const salary =
    job.salary_min != null || job.salary_max != null
      ? `${job.salary_min ?? ''}${job.salary_min != null && job.salary_max != null && job.salary_min !== job.salary_max ? `–${job.salary_max}` : job.salary_min == null ? job.salary_max : ''} ${job.salary_currency ?? 'AZN'}`
      : 'Razılaşma yolu ilə';
  return [
    job.id
      ? `#${job.id} — ${String(job.title).slice(0, 120)}`
      : String(job.title ?? '').slice(0, 120),
    `🏢 ${String(job.company_name ?? '-').slice(0, 160)}`,
    `📍 ${String(job.location_name ?? '-').slice(0, 250)}`,
    `💼 ${job.work_mode ?? '-'}`,
    `💰 ${salary}`,
    `📝 ${String(job.description ?? '-').slice(0, 1500)}`,
    `☎️ ${String(job.contact_phone ?? '-').slice(0, 25)}`,
    `📧 ${String(job.contact_email ?? '-').slice(0, 254)}`,
    ...(job.source_url
      ? [`🔗 ${String(job.source ?? '').slice(0, 40)}: ${String(job.source_url).slice(0, 1000)}`]
      : []),
  ].join('\n');
}
