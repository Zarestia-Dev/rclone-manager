import type { TranslationResult } from '@app/types';

export function relativeTimeLabel(timestamp: string, now = Date.now()): TranslationResult | null {
  const diff = now - Date.parse(timestamp);
  if (!Number.isFinite(diff)) return null;
  const minutes = Math.floor(diff / 60000);
  if (minutes <= 0) return { key: 'shared.transferActivity.time.justNow' };
  if (minutes < 60)
    return { key: 'shared.transferActivity.time.minutesAgo', params: { count: minutes } };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { key: 'shared.transferActivity.time.hoursAgo', params: { count: hours } };
  return {
    key: 'shared.transferActivity.time.daysAgo',
    params: { count: Math.floor(hours / 24) },
  };
}
