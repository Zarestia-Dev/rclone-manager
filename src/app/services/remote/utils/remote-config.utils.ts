import { RcConfigOption, RcConfigExample } from '@app/types';

import { TYPE_DEFAULT_EXAMPLES } from './remote-config-examples.constant';

export function resolveOptionExamples(opt: RcConfigOption | null | undefined): RcConfigExample[] {
  if (!opt) return [];
  if (opt.Examples && opt.Examples.length > 0) {
    return [...opt.Examples];
  }

  const typeKey = opt.Type;
  if (typeKey && TYPE_DEFAULT_EXAMPLES[typeKey]) {
    return [...TYPE_DEFAULT_EXAMPLES[typeKey]];
  }

  const rawName = (opt.Name || opt.FieldName || '').toLowerCase();
  const normalizedKey = rawName.replace(/^--?/, '').replace(/[- ]/g, '_');

  // Bandwidth limit options default to BwTimetable examples
  if (normalizedKey.includes('bwlimit') || normalizedKey.includes('bandwidth')) {
    const bwExamples = TYPE_DEFAULT_EXAMPLES['BwTimetable'];
    return bwExamples ? [...bwExamples] : [];
  }
  return [];
}

export function stripCliPrefix(query: string): string {
  const q = query.toLowerCase().trim();
  if (q.startsWith('--')) {
    return q.slice(2);
  }
  if (q.startsWith('-')) {
    return q.slice(1);
  }
  return q;
}

function normalizeSearchText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_\s]+/g, ' ')
    .toLowerCase()
    .trim();
}

export function matchesConfigSearchText(
  query: string,
  values: readonly (string | null | undefined)[]
): boolean {
  const terms = normalizeSearchText(query).split(' ').filter(Boolean);
  const texts = values.flatMap(value =>
    value ? [value.toLowerCase(), normalizeSearchText(value)] : []
  );
  return terms.every(term => texts.some(text => text.includes(term)));
}

export function getConfigOptionFlags(field: RcConfigOption, provider?: string | null): string[] {
  if (!field.Name || field.Name === 'mountType' || field.Name === 'type') return [];

  const name = field.Name.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
  const prefix = provider?.trim().toLowerCase();
  return [`--${prefix && !field.NoPrefix ? `${prefix}-` : ''}${name}`];
}

export interface ConfigSearchContext {
  provider?: string | null;
  keywords?: readonly string[];
}

export function matchesConfigSearch(
  field: RcConfigOption,
  query: string,
  context: ConfigSearchContext = {}
): boolean {
  if (!query.trim()) return true;

  const q = stripCliPrefix(query);
  const names = [field.Name, field.FieldName, ...getConfigOptionFlags(field, context.provider)];

  // A CLI flag names one option; do not match its words scattered through help text.
  if (query.trim().startsWith('-')) {
    const normalized = normalizeSearchText(q);
    return names.some(
      name =>
        name && (name.toLowerCase().includes(q) || normalizeSearchText(name).includes(normalized))
    );
  }

  return matchesConfigSearchText(query, [...names, field.Help, ...(context.keywords ?? [])]);
}

export function groupBy<T, K extends PropertyKey>(
  array: T[],
  keyGetter: (item: T) => K
): Record<K, T[]> {
  return array.reduce(
    (acc, item) => {
      const key = keyGetter(item);
      (acc[key] ??= []).push(item);
      return acc;
    },
    {} as Record<K, T[]>
  );
}
