import { Pipe, PipeTransform, inject } from '@angular/core';
import { formatDate } from 'src/app/services/i18n/locale-format';
import { LocaleService } from 'src/app/services/i18n/locale.service';

/**
 * Formats an ISO date string as a date and time in the language of the interface.
 * Impure so it follows a language change; the `Intl` formatter is cached, so a call per
 * visible row stays cheap.
 */
@Pipe({
  name: 'formatRelativeDate',
  pure: false,
})
export class FormatRelativeDatePipe implements PipeTransform {
  private readonly locale = inject(LocaleService);

  transform(dateString: string): string {
    return formatDate(this.locale.locale(), dateString, 'compact');
  }
}
