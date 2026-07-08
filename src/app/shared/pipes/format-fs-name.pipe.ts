import { Pipe, PipeTransform } from '@angular/core';

/**
 * Format a filesystem (fs) name for display.
 *
 * Strips the trailing colon used by rclone remote prefixes (e.g.
 * `"mydrive:"` -> `"mydrive"`) for cleaner display, while preserving
 * Windows drive letters (e.g. `"C:"`) verbatim.
 */
@Pipe({
  name: 'formatFsName',
  pure: true,
})
export class FormatFsNamePipe implements PipeTransform {
  transform(fs: string | null | undefined): string {
    if (!fs) return '';
    if (/^[a-zA-Z]:$/.test(fs)) {
      return fs;
    }
    return fs.endsWith(':') ? fs.slice(0, -1) : fs;
  }
}
