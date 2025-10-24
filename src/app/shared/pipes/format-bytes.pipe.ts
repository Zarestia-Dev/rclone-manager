import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'formatBytesPerSecond',
  standalone: true,
  pure: true,
})
export class FormatBytes implements PipeTransform {
  transform(bytes: number): string {
    if (bytes <= 0) return 'Unlimited';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${units[i]}/s`;
  }
}
