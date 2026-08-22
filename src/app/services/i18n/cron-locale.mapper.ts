import 'cronstrue/locales/tr';
import 'cronstrue/locales/es';
import 'cronstrue/locales/zh_CN';
import 'cronstrue/locales/zh_TW';
import 'cronstrue/locales/fr';
import 'cronstrue/locales/pt_BR';
import 'cronstrue/locales/ru';
import 'cronstrue/locales/ja';
import 'cronstrue/locales/uk';
import { toString as cronstrue } from 'cronstrue';

/**
 * Maps an app locale (e.g. 'en-US', 'tr-TR', 'pt-BR') to a cronstrue locale (e.g. 'en', 'tr', 'pt_BR').
 * cronstrue uses 2-letter codes for most languages; Chinese and Portuguese require region variants.
 */
export function getCronstrueLocale(appLocale: string): string {
  if (!appLocale) return 'en';

  const [lang, region] = appLocale.toLowerCase().split('-');

  if (lang === 'zh') {
    return region === 'tw' ? 'zh_TW' : 'zh_CN';
  }

  if (lang === 'pt') {
    return region === 'pt' ? 'pt_PT' : 'pt_BR';
  }

  return lang;
}

export function formatCronHumanReadable(cron: string, lang: string | null | undefined): string {
  if (!cron) return '';
  try {
    const locale = getCronstrueLocale(lang ?? 'en-US');
    return cronstrue(cron, { locale });
  } catch {
    return cron;
  }
}
