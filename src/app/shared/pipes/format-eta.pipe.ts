import { Pipe, PipeTransform, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

@Pipe({
  name: 'formatEta',
  pure: false,
})
export class FormatEtaPipe implements PipeTransform {
  private readonly translate = inject(TranslateService);

  transform(eta: number | string): string {
    if (typeof eta === 'string') return eta;
    if (eta <= 0 || !isFinite(eta)) return this.translate.instant('common.unknown');
    return this.formatDuration(eta);
  }

  /** The two largest units that are not zero: `45s`, `2m 5s`, `1h 3m`, `2d 4h`. */
  private formatDuration(seconds: number): string {
    const total = Math.round(seconds);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const parts: [number, string][] =
      days > 0
        ? [
            [days, 'd'],
            [hours, 'h'],
          ]
        : hours > 0
          ? [
              [hours, 'h'],
              [minutes, 'm'],
            ]
          : minutes > 0
            ? [
                [minutes, 'm'],
                [secs, 's'],
              ]
            : [[secs, 's']];
    return parts
      .filter(([value], index) => index === 0 || value > 0)
      .map(([value, unit]) => `${value}${unit}`)
      .join(' ');
  }
}
