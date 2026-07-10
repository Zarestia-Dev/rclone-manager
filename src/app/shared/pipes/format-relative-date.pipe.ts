import { Pipe, PipeTransform } from '@angular/core';

/**
 * Formats an ISO date string as a localized relative date.
 * Pure pipe: only recomputes when the input string reference changes,
 * so per-row template usage stays cheap across change-detection cycles.
 */
@Pipe({
  name: 'formatRelativeDate',
  pure: true,
})
export class FormatRelativeDatePipe implements PipeTransform {
  private readonly _formatter = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  transform(dateString: string): string {
    if (!dateString) return '';
    return this._formatter.format(new Date(dateString));
  }
}
