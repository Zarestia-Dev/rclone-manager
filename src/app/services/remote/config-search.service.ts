import { Injectable, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { RcConfigOption } from '@app/types';
import { translateRcloneOption } from '../i18n/rclone-option-translation';
import { matchesConfigSearch, matchesConfigSearchText } from './utils/remote-config.utils';

@Injectable({ providedIn: 'root' })
export class ConfigSearchService {
  private readonly translate = inject(TranslateService);

  matchesText(
    query: string,
    values: readonly string[],
    translationKeys: readonly string[] = []
  ): boolean {
    if (!query.trim()) return true;
    return matchesConfigSearchText(query, [
      ...values,
      ...translationKeys
        .map(key => this.translate.instant(key))
        .filter((value): value is string => typeof value === 'string'),
    ]);
  }

  matches(
    field: RcConfigOption,
    query: string,
    provider?: string | null,
    keywords: readonly string[] = []
  ): boolean {
    if (!query.trim()) return true;
    if (query.trimStart().startsWith('-')) return matchesConfigSearch(field, query, { provider });

    const translate = (key: string): unknown => this.translate.instant(key);
    return matchesConfigSearch(field, query, {
      provider,
      keywords: [
        ...keywords,
        translateRcloneOption(
          field.Name,
          'title',
          field.FieldName || field.Name,
          translate,
          provider
        ),
        translateRcloneOption(field.Name, 'help', field.Help, translate, provider),
      ],
    });
  }
}
