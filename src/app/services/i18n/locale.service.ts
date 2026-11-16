import { DOCUMENT } from '@angular/common';
import { Injectable, computed, effect, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

export const DEFAULT_LOCALE = 'en-US';

/**
 * The language the interface shows, as a BCP 47 tag.
 *
 * It keeps `<html lang>` in step with that language, so CSS `text-transform`, hyphenation,
 * spell checking, screen readers and the glyph choice for Chinese and Japanese follow it, and
 * the date, number and case pipes format with it. Instantiated at startup (`app.config.ts`).
 */
@Injectable({ providedIn: 'root' })
export class LocaleService {
  private readonly translate = inject(TranslateService);

  readonly locale = computed(() => this.translate.currentLang() ?? DEFAULT_LOCALE);

  constructor() {
    const root = inject(DOCUMENT).documentElement;
    effect(() => {
      root.lang = this.locale();
    });
  }
}
