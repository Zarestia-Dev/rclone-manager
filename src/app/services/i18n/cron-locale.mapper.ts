import 'cronstrue/locales/tr';
import 'cronstrue/locales/es';
import 'cronstrue/locales/zh_CN';
import 'cronstrue/locales/zh_TW';

/**
 * Maps an app locale (e.g. 'en-US', 'tr-TR') to a cronstrue locale (e.g. 'en', 'tr').
 * cronstrue uses 2-letter codes; Chinese is the only exception requiring a region suffix.
 */
export function getCronstrueLocale(appLocale: string): string {
  if (!appLocale) return 'en';

  const [lang, region] = appLocale.toLowerCase().split('-');

  if (lang === 'zh') {
    return region === 'tw' ? 'zh_TW' : 'zh_CN';
  }

  return lang;
}
