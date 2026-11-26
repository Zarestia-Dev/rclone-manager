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

/**
 * The name a copy gets beside an item of the same name, as a file manager names it:
 * `report (2).pdf`, then `report (3).pdf`… A file keeps its extension (`.tar.gz` as one); a
 * folder, or a file whose only dot leads its name (`.bashrc`), takes the number at the end.
 * Copying a copy counts on from its number instead of stacking them. With `ignoreCase`, as on a
 * destination that does not tell `A` from `a`, a name taken in any case is taken.
 */
export function findCopyName(
  name: string,
  isDir: boolean,
  existing: Iterable<string>,
  ignoreCase = false
): string {
  const fold = (value: string): string => (ignoreCase ? value.toLowerCase() : value);
  const taken = new Set([...existing].map(fold));
  const extension = isDir ? '' : (/(?:\.tar)?\.[^.\s]+$/.exec(name.slice(1))?.[0] ?? '');
  const base = name.slice(0, name.length - extension.length).replace(/ \(\d+\)$/, '');
  let n = 2;
  while (taken.has(fold(`${base} (${n})${extension}`))) n++;
  return `${base} (${n})${extension}`;
}
