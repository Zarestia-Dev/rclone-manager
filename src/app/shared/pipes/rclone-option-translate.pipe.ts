import { Pipe, PipeTransform, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

@Pipe({
  name: 'rcloneOptionTranslate',
  standalone: true,
  pure: false,
})
export class RcloneOptionTranslatePipe implements PipeTransform {
  private translate = inject(TranslateService);

  transform(
    optionName: string,
    type: 'title' | 'help',
    fallback: string,
    provider?: string | null
  ): string {
    if (!optionName) return fallback;

    // Normalize option name: replace hyphens with underscores
    // Rclone flags are often kebab-case (allow-other), but our JSON keys are snake_case (allow_other)
    const normalizedName = optionName.replace(/-/g, '_');

    // 1. Try provider-specific translation first if provider is given
    if (provider) {
      const providerKey = `providers.${provider}.${normalizedName}.${type}`;
      const providerTranslation = this.translate.instant(providerKey);
      if (providerTranslation !== providerKey) {
        return providerTranslation;
      }
    }

    // 2. Fallback to global translation
    const globalKey = `${normalizedName}.${type}`;
    const globalTranslation = this.translate.instant(globalKey);

    // If translation returns the key itself, it means no translation was found
    return globalTranslation === globalKey ? fallback : globalTranslation;
  }
}
