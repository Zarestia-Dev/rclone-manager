import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'formatFileSize',
  standalone: true,
  pure: true,
})
export class FormatFileSizePipe implements PipeTransform {
  transform(bytes: number): string {
    if (bytes < 0 || bytes === undefined || bytes === null) return 'N/A';
    if (bytes === 0) return '0 B';

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 2 : 0)} ${units[i]}`;
  }
}
