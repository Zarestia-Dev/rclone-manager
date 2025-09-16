import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'formatEta',
  standalone: true,
  pure: true,
})
export class FormatEtaPipe implements PipeTransform {
  transform(eta: number | string): string {
    if (typeof eta === 'string') return eta;
    if (eta <= 0 || !isFinite(eta)) return 'Unknown';
    return this.formatDuration(eta);
  }

  private formatDuration(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
    return `${Math.round(seconds / 86400)}d`;
  }
}
