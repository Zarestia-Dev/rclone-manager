import { Pipe, PipeTransform, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

@Pipe({
  name: 'rcloneOptionTranslate',
  standalone: true,
  pure: false,
})
export class RcloneOptionTranslatePipe implements PipeTransform {
  private translate = inject(TranslateService);

  transform(optionName: string, type: 'title' | 'help', fallback: string): string {
    if (!optionName) return fallback;

    const key = `${optionName}.${type}`;
    const translation = this.translate.instant(key);

    // If translation returns the key itself, it means no translation was found
    return translation === key ? fallback : translation;
  }
}
