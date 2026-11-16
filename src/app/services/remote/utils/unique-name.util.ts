export function findUniqueName(base: string, existing: Iterable<string>, separator = '-'): string {
  const existingSet = new Set(existing);
  if (!existingSet.has(base)) return base;
  let c = 1;
  while (existingSet.has(`${base}${separator}${c}`)) c++;
  return `${base}${separator}${c}`;
}

/**
 * The name of a copy: `drive` and `drive-clone-2` both give `drive-clone`, then `drive-clone-1`, ...
 * Only the suffix a copy gets is removed, so a number that belongs to the name (`backup-2024`) stays.
 */
export function findCloneName(name: string, existing: Iterable<string>): string {
  const root = name.replace(/-clone(?:-\d+)*$/, '') || 'remote';
  return findUniqueName(`${root}-clone`, existing);
}
