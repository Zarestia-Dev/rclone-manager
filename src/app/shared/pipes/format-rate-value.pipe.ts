import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'formatRateValue',
  standalone: true,
  pure: true,
})
export class FormatRateValuePipe implements PipeTransform {
  transform(rate: number | string | null | undefined): string {
    if (!rate || rate === 'off' || rate === '') {
      return 'Unlimited';
    }

    if (typeof rate === 'number') {
      return this.formatBytesPerSecond(rate);
    }

    if (rate.includes(':')) {
      // Handle combined rates like "10Ki:100Ki" (upload:download)
      const [upload, download] = rate.split(':');
      const parts = [];
      if (download) parts.push(`↓ ${this.parseRateString(download)}`);
      if (upload) parts.push(`↑ ${this.parseRateString(upload)}`);
      return parts.join(' ');
    }
    return `Limited to ${this.parseRateString(rate)}`;
  }

  private parseRateString(rateStr: string): string {
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
    return this.formatBytesPerSecond(bytes);
  }

  private formatBytesPerSecond(bytes: number): string {
    if (bytes <= 0) return 'Unlimited';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${units[i]}/s`;
  }
}
