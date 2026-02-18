import 'cronstrue/locales/tr';

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
  const baseLocale = appLocale.split('-')[0].toLowerCase();

  // Handle any specific edge cases or mapping overrides here if needed
  // For now, the base locale usually matches cronstrue's support
  return baseLocale;
}
