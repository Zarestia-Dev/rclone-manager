import {
  FlagType,
  OPERATION_REGISTRY,
  RcConfigOption,
  TEMPLATE_CATEGORIES,
  TemplateCategory,
} from '@app/types';

export function getConfigCategories(context?: string | null): readonly TemplateCategory[] {
  if (!context) return TEMPLATE_CATEGORIES;
  if (context === 'remote') return ['remote'];
  if (context === 'runtimeRemote') return [];
  const operation = OPERATION_REGISTRY.find(op => op.key === context);
  const categories: TemplateCategory[] = [context as FlagType];
  if (operation?.hasLinkedProfiles) {
    if (operation.supportsVfs) categories.push('vfs');
    categories.push('filter', 'backend');
  }
  return categories;
}

export function resolveProviderField(fields: readonly RcConfigOption[]): RcConfigOption | null {
  const provider = fields.find(field => field.Name === 'provider' && field.Examples?.length);
  if (provider) return provider;
  return fields.some(field => field.Provider)
    ? (fields.find(field => field.Examples?.length) ?? null)
    : null;
}

export function matchesProviderRule(rule: string | undefined, provider?: string): boolean {
  if (!rule) return true;
  if (!provider) return false;
  const negated = rule.startsWith('!');
  const providers = (negated ? rule.slice(1) : rule).split(',').map(value => value.trim());
  return negated ? !providers.includes(provider) : providers.includes(provider);
}

export function isProviderReady(
  type: string | null | undefined,
  providerField: RcConfigOption | null,
  value: unknown
): boolean {
  return !!type && (!providerField || !!value);
}
