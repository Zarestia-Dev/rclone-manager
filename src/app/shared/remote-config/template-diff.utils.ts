import {
  TemplateCategory,
  TEMPLATE_CATEGORIES,
  isTemplateCategory,
  OPERATION_REGISTRY,
  FlagType,
} from '@app/types';
import { deepEqual, formatValueDisplay } from 'src/app/shared/utils';

export type DiffStatus = 'added' | 'modified' | 'unchanged';
export type ApplyStrategy = 'overwrite' | 'fill-empty';

export interface TemplateDiffItem {
  id: string;
  category: TemplateCategory;
  key: string;
  currentValue: unknown;
  newValue: unknown;
  currentDisplay: string;
  newDisplay: string;
  status: DiffStatus;
}

export interface TemplateDiffResult {
  items: TemplateDiffItem[];
  byCategory: Partial<Record<TemplateCategory, TemplateDiffItem[]>>;
  categories: TemplateCategory[];
  totalAdded: number;
  totalModified: number;
  totalUnchanged: number;
  totalCount: number;
  hasChanges: boolean;
}

export function isValueEmpty(val: unknown): boolean {
  return val === undefined || val === null || val === '';
}

/**
 * Resolves the list of TemplateCategories applicable to a given configuration context
 * (such as 'mount', 'sync', 'vfs', 'filter', 'backend', 'remote', or null for all).
 *
 * Uses OPERATION_REGISTRY as the single source of truth to avoid any code duplication.
 */
export function getApplicableTemplateCategories(
  context?: string | null
): readonly TemplateCategory[] {
  if (!context) {
    return TEMPLATE_CATEGORIES;
  }
  if (context === 'remote') {
    return ['remote'];
  }
  if (context === 'vfs' || context === 'filter' || context === 'backend') {
    return [context as TemplateCategory];
  }
  if (context === 'runtimeRemote') {
    return [];
  }

  const op = OPERATION_REGISTRY.find(o => o.key === context);
  if (op) {
    const list: TemplateCategory[] = [context as FlagType];
    if (op.hasLinkedProfiles) {
      if (op.supportsVfs) {
        list.push('vfs');
      }
      list.push('filter', 'backend');
    }
    return list;
  }
  return [context as FlagType];
}

/**
 * Computes difference between current form values and proposed template values.
 * Optionally constrained by applicableCategories for the active context.
 */
export function computeTemplateDiff(
  currentValues?: Partial<Record<TemplateCategory, Record<string, unknown>>>,
  templateValues?: Partial<Record<TemplateCategory, Record<string, unknown>>>,
  applicableCategories?: readonly TemplateCategory[]
): TemplateDiffResult {
  const items: TemplateDiffItem[] = [];
  const byCategory: Partial<Record<TemplateCategory, TemplateDiffItem[]>> = {};
  const allowedSet = applicableCategories ? new Set(applicableCategories) : null;

  if (templateValues) {
    for (const [cat, kvObj] of Object.entries(templateValues)) {
      if (!isTemplateCategory(cat) || !kvObj || typeof kvObj !== 'object') continue;
      if (allowedSet && !allowedSet.has(cat)) continue;

      const catItems: TemplateDiffItem[] = [];
      const currentCatObj = currentValues?.[cat];

      for (const [key, templateVal] of Object.entries(kvObj)) {
        if (templateVal === undefined) continue;

        const currentVal = currentCatObj?.[key];
        let status: DiffStatus;

        if (isValueEmpty(currentVal) && !isValueEmpty(templateVal)) {
          status = 'added';
        } else if (deepEqual(currentVal, templateVal)) {
          status = 'unchanged';
        } else {
          status = 'modified';
        }

        const item: TemplateDiffItem = {
          id: `${cat}:${key}`,
          category: cat,
          key,
          currentValue: currentVal,
          newValue: templateVal,
          currentDisplay: isValueEmpty(currentVal) ? '—' : formatValueDisplay(currentVal),
          newDisplay: formatValueDisplay(templateVal),
          status,
        };

        items.push(item);
        catItems.push(item);
      }

      if (catItems.length > 0) {
        byCategory[cat] = catItems;
      }
    }
  }

  const categories = Object.keys(byCategory) as TemplateCategory[];
  let totalAdded = 0;
  let totalModified = 0;
  let totalUnchanged = 0;

  for (const item of items) {
    if (item.status === 'added') totalAdded++;
    else if (item.status === 'modified') totalModified++;
    else totalUnchanged++;
  }

  return {
    items,
    byCategory,
    categories,
    totalAdded,
    totalModified,
    totalUnchanged,
    totalCount: items.length,
    hasChanges: totalAdded > 0 || totalModified > 0,
  };
}

export interface FilterTemplateOptions {
  strategy: ApplyStrategy;
  selectedCategories: readonly TemplateCategory[];
  currentValues?: Partial<Record<TemplateCategory, Record<string, unknown>>>;
  selectedItemIds?: ReadonlySet<string>;
  applicableCategories?: readonly TemplateCategory[];
}

/**
 * Filters template values based on user-chosen categories, strategy (overwrite vs fill-empty),
 * individual item selections, and optional context-applicable categories.
 */
export function filterTemplateValues(
  templateValues: Partial<Record<TemplateCategory, Record<string, unknown>>>,
  options: FilterTemplateOptions
): Partial<Record<TemplateCategory, Record<string, unknown>>> {
  const result: Partial<Record<TemplateCategory, Record<string, unknown>>> = {};
  const selectedCatSet = new Set(options.selectedCategories);
  const allowedSet = options.applicableCategories ? new Set(options.applicableCategories) : null;

  for (const [cat, kvObj] of Object.entries(templateValues)) {
    if (!isTemplateCategory(cat) || !selectedCatSet.has(cat) || !kvObj) continue;
    if (allowedSet && !allowedSet.has(cat)) continue;

    const currentCatObj = options.currentValues?.[cat];
    const filteredCatObj: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(kvObj)) {
      if (val === undefined) continue;

      const itemId = `${cat}:${key}`;
      if (options.selectedItemIds && !options.selectedItemIds.has(itemId)) {
        continue;
      }

      if (options.strategy === 'fill-empty') {
        const currentVal = currentCatObj?.[key];
        if (!isValueEmpty(currentVal)) {
          // Do not overwrite existing non-empty value
          continue;
        }
      }

      filteredCatObj[key] = val;
    }

    if (Object.keys(filteredCatObj).length > 0) {
      result[cat] = filteredCatObj;
    }
  }

  return result;
}
