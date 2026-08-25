import { FlagType, FLAG_TYPES } from './remote-config';

export type TemplateCategory = FlagType | 'remote';

export const TEMPLATE_CATEGORIES: readonly TemplateCategory[] = Object.freeze([
  ...FLAG_TYPES,
  'remote',
]);

const TEMPLATE_CATEGORY_KEYS: ReadonlySet<string> = new Set<string>(
  TEMPLATE_CATEGORIES as readonly string[]
);

export function isTemplateCategory(value: unknown): value is TemplateCategory {
  return typeof value === 'string' && TEMPLATE_CATEGORY_KEYS.has(value);
}

export function isTemplateCategoryRecord(
  value: unknown
): value is Partial<Record<TemplateCategory, Record<string, unknown>>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!isTemplateCategory(key)) return false;
    const sub = obj[key];
    if (sub !== undefined && sub !== null) {
      if (typeof sub !== 'object' || Array.isArray(sub)) return false;
    }
  }
  return true;
}

export interface UserPresetTemplate {
  id: string;
  name: string;
  description?: string;
  values: Partial<Record<TemplateCategory, Record<string, unknown>>>;
}

export interface ApplyTemplateOptions {
  categories?: TemplateCategory[];
  overwriteExisting?: boolean;
}
