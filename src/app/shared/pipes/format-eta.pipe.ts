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

  private formatDuration(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
    return `${Math.round(seconds / 86400)}d`;
  }
}
