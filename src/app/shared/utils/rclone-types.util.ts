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

/** Rclone option types that serialize as delimited strings (e.g. "a,b" or "a b") */
export const DELIMITED_ARRAY_TYPES: ReadonlySet<string> = new Set([
  'CommaSepList',
  'SpaceSepList',
  'Bits',
  'Encoding',
  'DumpFlags',
]);

export const COMMA_ARRAY_TYPES: ReadonlySet<string> = new Set(
  [...DELIMITED_ARRAY_TYPES].filter(t => t !== 'SpaceSepList')
);

export const ARRAY_TYPES: ReadonlySet<string> = new Set([
  ...JSON_ARRAY_TYPES,
  ...DELIMITED_ARRAY_TYPES,
]);

export const MULTISELECT_TYPES: ReadonlySet<string> = ARRAY_TYPES;

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

export function isJsonArrayType(type: string): boolean {
  return JSON_ARRAY_TYPES.has(type);
}

export function isCommaArrayType(type: string): boolean {
  return COMMA_ARRAY_TYPES.has(type);
}

export function isMultiselectType(type: string): boolean {
  return ARRAY_TYPES.has(type);
}

export function isConvertibleType(type: string): boolean {
  return CONVERTIBLE_TYPES.has(type);
}

export function isTristateType(type: string): boolean {
  return TRISTATE_TYPES.has(type);
}
