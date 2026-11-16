import { Pipe, PipeTransform, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { formatNumber } from 'src/app/services/i18n/locale-format';
import { LocaleService } from 'src/app/services/i18n/locale.service';

@Pipe({
  name: 'formatRateValue',
  pure: false,
})
export class FormatRateValuePipe implements PipeTransform {
  private readonly translate = inject(TranslateService);
  private readonly locale = inject(LocaleService);

  transform(rate: number | string | null | undefined): string {
    if (rate === null || rate === undefined || rate === 'off' || rate === '') {
      return this.unlimited();
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
    return this.translate.instant('common.limitedTo', { rate: this.parseRateString(rate) });
  }

  private parseRateString(rateStr: string): string {
    if (!rateStr || rateStr === 'off') return this.unlimited();
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
    if (bytes <= 0) return '0 B/s';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${formatNumber(this.locale.locale(), bytes / Math.pow(1024, i), 2)} ${units[i]}/s`;
  }

  private unlimited(): string {
    return this.translate.instant('common.unlimited');
  }
}
