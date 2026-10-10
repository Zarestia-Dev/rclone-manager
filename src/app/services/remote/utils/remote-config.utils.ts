import { RcConfigOption, RcConfigExample } from '@app/types';

import { TYPE_DEFAULT_EXAMPLES } from './remote-config-examples.constant';

// Re-export modular domain utilities for 100% backward compatibility
export * from './interactive-flow.utils';
export * from './profile-mapper.utils';

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

function normalizeRcloneKey(val: string | undefined | null): string {
  return val ? val.toLowerCase().replace(/[- ]/g, '_') : '';
}

export function matchesConfigSearch(field: RcConfigOption, query: string): boolean {
  if (!query) return true;

  const q = stripCliPrefix(query);
  const flexQ = normalizeRcloneKey(q);

  return (
    (field.Name?.toLowerCase() ?? '').includes(q) ||
    (field.FieldName?.toLowerCase() ?? '').includes(q) ||
    (field.Help?.toLowerCase() ?? '').includes(q) ||
    normalizeRcloneKey(field.Name).includes(flexQ) ||
    normalizeRcloneKey(field.FieldName).includes(flexQ)
  );
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
