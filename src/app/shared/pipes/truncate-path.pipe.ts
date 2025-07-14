import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'truncatePath',
  standalone: true,
  pure: true,
})
export class TruncatePathPipe implements PipeTransform {
  transform(path: string, maxLength = 32): string {
    if (!path) return '';
    if (path.length <= maxLength) return path;
    const start = path.slice(0, 12);
    const end = path.slice(-12);
    return start + '...' + end;
  }
}
