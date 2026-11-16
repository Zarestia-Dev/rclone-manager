import { Pipe, PipeTransform, inject } from '@angular/core';
import { DateStyle, formatDate } from 'src/app/services/i18n/locale-format';
import { LocaleService } from 'src/app/services/i18n/locale.service';

/**
 * A date in the language of the interface: `{{ value | formatDate: 'medium' }}`.
 * Styles: `medium` (date and time), `short`, `compact` (month as a word, no seconds), `date`,
 * `time`, `timeShort`, `clock` (24-hour HH:mm:ss) and `clockMs` (with milliseconds). Impure so it follows a language change; the
 * `Intl` formatter is cached, so a call is cheap.
 */
@Pipe({ name: 'formatDate', pure: false })
export class FormatDatePipe implements PipeTransform {
  private readonly locale = inject(LocaleService);

  transform(value: Date | string | number | null | undefined, style: DateStyle = 'medium'): string {
    return formatDate(this.locale.locale(), value, style);
  }
}
