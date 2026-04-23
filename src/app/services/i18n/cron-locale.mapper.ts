import 'cronstrue/locales/tr';
import 'cronstrue/locales/es';
import 'cronstrue/locales/zh_CN';

/**
 * Maps the application locale (e.g., 'en-US', 'tr-TR') to a cronstrue supported locale (e.g., 'en', 'tr').
 * @param appLocale The application locale string.
 * @returns The corresponding cronstrue locale string.
 */
export function getCronstrueLocale(appLocale: string): string {
  if (!appLocale) {
    return 'en';
  }

  // cronstrue typically uses 2-letter codes (e.g., 'en', 'tr', 'fr')
  // We'll strip the region variant (e.g., 'tr-TR' -> 'tr')
  const parts = appLocale.toLowerCase().split('-');
  const baseLocale = parts[0];

  // Handle specific overrides for cronstrue
  if (baseLocale === 'zh') {
    return parts[1] === 'tw' ? 'zh_TW' : 'zh_CN';
  }

  return baseLocale;
}
