import { Pipe, PipeTransform, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { translateRcloneOption } from 'src/app/services/i18n/rclone-option-translation';

@Pipe({
  name: 'rcloneOptionTranslate',
  pure: true,
})
export class RcloneOptionTranslatePipe implements PipeTransform {
  private translate = inject(TranslateService);

  transform(
    optionName: string,
    type: 'title' | 'help',
    fallback: string,
    provider?: string | null,
    _langRefresh?: string | null
  ): string {
    return translateRcloneOption(
      optionName,
      type,
      fallback,
      key => this.translate.instant(key),
      provider
    );
  }
}
