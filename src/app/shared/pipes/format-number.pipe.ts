import { Pipe, PipeTransform, inject } from '@angular/core';
import { formatNumber } from 'src/app/services/i18n/locale-format';
import { LocaleService } from 'src/app/services/i18n/locale.service';

/**
 * A number with the separators of the language of the interface:
 * `{{ value | formatNumber }}` or `{{ value | formatNumber: 1 }}` for at most one decimal.
 * Impure so it follows a language change; the `Intl` formatter is cached.
 */
@Pipe({ name: 'formatNumber', pure: false })
export class FormatNumberPipe implements PipeTransform {
  private readonly locale = inject(LocaleService);

  transform(value: number | null | undefined, maxFractionDigits = 3): string {
    if (value === null || value === undefined || Number.isNaN(value)) return '';
    return formatNumber(this.locale.locale(), value, maxFractionDigits);
  }
}
