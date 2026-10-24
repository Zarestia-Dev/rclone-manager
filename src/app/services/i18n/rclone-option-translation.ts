export function translateRcloneOption(
  optionName: string,
  type: 'title' | 'help',
  fallback: string,
  translate: (key: string) => unknown,
  provider?: string | null
): string {
  if (!optionName) return fallback;

  const normalizedName = optionName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
  const keys = [`${normalizedName}.${type}`];
  if (provider) keys.unshift(`providers.${provider}.${normalizedName}.${type}`);

  for (const key of keys) {
    const translated = translate(key);
    if (typeof translated === 'string' && translated !== key) return translated;
  }
  return fallback;
}
