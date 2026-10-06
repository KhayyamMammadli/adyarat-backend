// Azerbaijan uses UTC+4. Calendar weeks start on Monday.
export function statisticsPeriod(period: 'day' | 'week', now = new Date()) {
  const local = new Date(now.getTime() + 4 * 3600000);
  const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const days = period === 'week' ? (local.getUTCDay() + 6) % 7 : 0;
  return {
    from: new Date(start - days * 86400000 - 4 * 3600000).toISOString(),
    to: now.toISOString(),
  };
}
