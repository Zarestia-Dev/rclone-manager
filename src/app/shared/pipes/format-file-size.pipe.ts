import { Pipe, PipeTransform, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { formatNumber } from 'src/app/services/i18n/locale-format';
import { LocaleService } from 'src/app/services/i18n/locale.service';

/**
 * A size in bytes with the decimal separator of the language of the interface.
 * Impure so it follows a language change; the `Intl` formatter is cached.
 */
@Pipe({
  name: 'formatFileSize',
  pure: false,
})
export class FormatFileSizePipe implements PipeTransform {
  private readonly units = ['B', 'KB', 'MB', 'GB', 'TB'];
  private readonly locale = inject(LocaleService);
  private readonly translate = inject(TranslateService);

  transform(bytes: number | null | undefined): string {
    if (bytes === undefined || bytes === null || bytes < 0) {
      return this.translate.instant('common.notAvailable');
    }
    if (bytes === 0) return '0 B';

    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), this.units.length - 1);
    const fraction = i > 0 ? 2 : 0;
    const value = formatNumber(this.locale.locale(), bytes / Math.pow(1024, i), fraction, fraction);
    return `${value} ${this.units[i]}`;
  }
}
