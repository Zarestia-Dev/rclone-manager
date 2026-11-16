import { Injectable, inject } from '@angular/core';
import {
  InterpolatableTranslation,
  InterpolatableTranslationObject,
  InterpolationParameters,
  TranslateCompiler,
  TranslateParser,
  TranslationObject,
} from '@ngx-translate/core';

const rulesByLang = new Map<string, Intl.PluralRules>();

/** The CLDR plural category (`one`, `few`, `many`, `other`, ...) of `count` in `lang`. */
export function pluralCategory(lang: string | null, count: number): Intl.LDMLPluralRule {
  const tag = lang || 'en-US';
  let rules = rulesByLang.get(tag);
  if (!rules) {
    try {
      rules = new Intl.PluralRules(tag);
    } catch {
      rules = new Intl.PluralRules('en-US');
    }
    rulesByLang.set(tag, rules);
  }
  return rules.select(count);
}

// Keep in sync with PLURAL_FORMS and isPluralGroup in scripts/audit-i18n-keys.cjs.
const PLURAL_FORMS = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

/**
 * A plural string is an object of plural forms that has `other`:
 * `{ "one": "{{count}} file", "other": "{{count}} files" }`.
 */
function isPluralGroup(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.some(([form]) => form === 'other') &&
    entries.every(([form, text]) => PLURAL_FORMS.has(form) && typeof text === 'string')
  );
}

/**
 * Turns every plural string of a language into a function of the interpolation
 * parameters, so `translate.instant(key, { count })` and `key | translate: { count }`
 * show the form of the language for `count`. A form the language does not translate
 * (or a call without `count`) shows `other`.
 */
@Injectable()
export class PluralCompiler extends TranslateCompiler {
  private readonly parser = inject(TranslateParser);

  compile(value: string): InterpolatableTranslation {
    return value;
  }

  compileTranslations(
    translations: TranslationObject,
    lang: string
  ): InterpolatableTranslationObject {
    return this.compileObject(translations, lang);
  }

  private compileObject(node: object, lang: string): InterpolatableTranslationObject {
    const result: InterpolatableTranslationObject = {};
    for (const [key, child] of Object.entries(node)) {
      result[key] = this.compileNode(child, lang);
    }
    return result;
  }

  private compileNode(node: unknown, lang: string): InterpolatableTranslation {
    if (isPluralGroup(node)) return this.compilePlural(node, lang);
    if (node && typeof node === 'object') return this.compileObject(node, lang);
    return node as InterpolatableTranslation;
  }

  private compilePlural(forms: Record<string, string>, lang: string) {
    return (params?: InterpolationParameters): string => {
      const count = Number(params?.['count']);
      const form = Number.isFinite(count) ? pluralCategory(lang, count) : 'other';
      return this.parser.interpolate(forms[form] ?? forms['other'], params) ?? '';
    };
  }
}
