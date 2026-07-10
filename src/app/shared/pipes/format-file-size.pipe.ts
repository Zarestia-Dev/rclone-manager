import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'formatFileSize',
  pure: true,
})
export class FormatFileSizePipe implements PipeTransform {
  private readonly units = ['B', 'KB', 'MB', 'GB', 'TB'];

  transform(bytes: number | null | undefined): string {
    if (bytes === undefined || bytes === null || bytes < 0) return 'N/A';
    if (bytes === 0) return '0 B';

    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), this.units.length - 1);
    return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 2 : 0)} ${this.units[i]}`;
  }
}
