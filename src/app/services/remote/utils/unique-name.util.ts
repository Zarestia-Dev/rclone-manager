export function findUniqueName(base: string, existing: Iterable<string>, separator = '-'): string {
  const existingSet = new Set(existing);
  if (!existingSet.has(base)) return base;
  let c = 1;
  while (existingSet.has(`${base}${separator}${c}`)) c++;
  return `${base}${separator}${c}`;
}
