import { toString as cronstrue } from 'cronstrue';

const loadedLocales = new Set<string>(['en']);

/**
 * Dynamically loads the required locale for cronstrue on demand.
 */
export async function ensureCronLocaleLoaded(locale: string): Promise<void> {
  if (loadedLocales.has(locale)) return;

  switch (locale) {
    case 'tr':
      await import('cronstrue/locales/tr');
      break;
    case 'es':
      await import('cronstrue/locales/es');
      break;
    case 'zh_CN':
      await import('cronstrue/locales/zh_CN');
      break;
    case 'zh_TW':
      await import('cronstrue/locales/zh_TW');
      break;
    case 'fr':
      await import('cronstrue/locales/fr');
      break;
    case 'pt_BR':
      await import('cronstrue/locales/pt_BR');
      break;
    case 'ru':
      await import('cronstrue/locales/ru');
      break;
    case 'ja':
      await import('cronstrue/locales/ja');
      break;
    case 'uk':
      await import('cronstrue/locales/uk');
      break;
  }

  loadedLocales.add(locale);
}

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
    if (!loadedLocales.has(locale)) {
      void ensureCronLocaleLoaded(locale);
    }
    return cronstrue(cron, { locale: loadedLocales.has(locale) ? locale : 'en' });
  } catch {
    return cron;
  }
}
