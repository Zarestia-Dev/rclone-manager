export const formatUtils = {
  bytes: (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${units[i]}`;
  },

  bytesPerSecond: (bytes: number): string => {
    if (bytes <= 0) return 'Unlimited';
    return `${formatUtils.bytes(bytes)}/s`;
  },

  duration: (seconds: number): string => {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
    return `${Math.round(seconds / 86400)}d`;
  },

  eta: (eta: number | string): string => {
    if (typeof eta === 'string') return eta;
    if (eta <= 0 || !isFinite(eta)) return 'Unknown';
    return formatUtils.duration(eta);
  },

  memoryUsage: (memoryStats: any | null): string => {
    return memoryStats?.HeapAlloc
      ? `${Math.round(memoryStats.HeapAlloc / 1024 / 1024)} MB`
      : 'Unknown';
  },

  rateValue: (rate: string): string => {
    if (!rate || rate === 'off' || rate === '') return 'Unlimited';
    if (rate.includes(':')) {
      // Handle combined rates like "10Ki:100Ki" (upload:download)
      const [upload, download] = rate.split(':');
      const parts = [];
      if (download) parts.push(`↓ ${formatUtils.parseRateString(download)}`);
      if (upload) parts.push(`↑ ${formatUtils.parseRateString(upload)}`);
      return parts.join(' ');
    }
    return `Limited to ${formatUtils.parseRateString(rate)}`;
  },

  parseRateString: (rateStr: string): string => {
    if (!rateStr || rateStr === 'off') return 'Unlimited';
    const match = rateStr.match(/^(\d+(?:\.\d+)?)\s*([KMGT]?i?)$/i);
    if (!match) return rateStr;
    const [, value, unit] = match;
    const numValue = parseFloat(value);
    const rcloneMultipliers = {
      '': 1,
      Ki: 1024,
      Mi: 1024 ** 2,
      Gi: 1024 ** 3,
      Ti: 1024 ** 4,
    };
    const multiplier = rcloneMultipliers[unit as keyof typeof rcloneMultipliers] || 1;
    const bytes = numValue * multiplier;
    return formatUtils.bytesPerSecond(bytes);
  },

  bandwidthDetails: (bandwidthLimit: any): { upload: string; download: string; total: string } => {
    const isUnlimited = (value: number): boolean => value <= 0;
    return {
      upload: isUnlimited(bandwidthLimit.bytesPerSecondTx)
        ? 'Unlimited'
        : formatUtils.bytesPerSecond(bandwidthLimit.bytesPerSecondTx),
      download: isUnlimited(bandwidthLimit.bytesPerSecondRx)
        ? 'Unlimited'
        : formatUtils.bytesPerSecond(bandwidthLimit.bytesPerSecondRx),
      total: isUnlimited(bandwidthLimit.bytesPerSecond)
        ? 'Unlimited'
        : formatUtils.bytesPerSecond(bandwidthLimit.bytesPerSecond),
    };
  },
};
