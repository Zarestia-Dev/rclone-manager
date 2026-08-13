export const INT_TYPES: ReadonlySet<string> = new Set([
  'int',
  'int64',
  'int32',
  'uint',
  'uint32',
  'uint64',
]);

export const FLOAT_TYPES: ReadonlySet<string> = new Set(['float', 'float32', 'float64']);

/** Rclone option types that serialize as native JSON arrays (e.g. ["a", "b"]) */
export const JSON_ARRAY_TYPES: ReadonlySet<string> = new Set([
  'stringArray',
  '[]string',
  'List',
  '[]int',
  '[]bool',
]);

/** Rclone option types that serialize as comma-delimited strings (e.g. "a,b,c"). */
export const COMMA_ARRAY_TYPES: ReadonlySet<string> = new Set([
  'CommaSepList',
  'Bits',
  'Encoding',
  'DumpFlags',
]);

/** Rclone option types that serialize as space-delimited strings (e.g. "a b c"). */
export const SPACE_ARRAY_TYPES: ReadonlySet<string> = new Set(['SpaceSepList']);

/** All delimited-array types (both comma- and space-separated). */
export const DELIMITED_ARRAY_TYPES: ReadonlySet<string> = new Set([
  ...COMMA_ARRAY_TYPES,
  ...SPACE_ARRAY_TYPES,
]);

export const ARRAY_TYPES: ReadonlySet<string> = new Set([
  ...JSON_ARRAY_TYPES,
  ...DELIMITED_ARRAY_TYPES,
]);

export const CONVERTIBLE_TYPES: ReadonlySet<string> = new Set([
  'Duration',
  'SizeSuffix',
  'BwTimetable',
  'FileMode',
]);

export const TRISTATE_TYPES: ReadonlySet<string> = new Set(['Tristate']);

export function isIntType(type: string): boolean {
  return INT_TYPES.has(type);
}

export function isFloatType(type: string): boolean {
  return FLOAT_TYPES.has(type);
}

export function isArrayType(type: string): boolean {
  return ARRAY_TYPES.has(type);
}

/** Alias kept for read-site clarity — same test as {@link isArrayType}. */
export function isMultiselectType(type: string): boolean {
  return ARRAY_TYPES.has(type);
}

export function isJsonArrayType(type: string): boolean {
  return JSON_ARRAY_TYPES.has(type);
}

export function isConvertibleType(type: string): boolean {
  return CONVERTIBLE_TYPES.has(type);
}
