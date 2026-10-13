import { Pipe, PipeTransform, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

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
    if (!optionName) return fallback;

    // Normalize option name: convert camelCase & hyphens to snake_case
    // Rclone flags are often camelCase (createEmptySrcDirs) or kebab-case (allow-other),
    // but our JSON keys are snake_case (create_empty_src_dirs, allow_other)
    const normalizedName = optionName
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/-/g, '_')
      .toLowerCase();

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
