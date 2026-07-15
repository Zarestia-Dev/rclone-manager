export const INT_TYPES: ReadonlySet<string> = new Set([
  'int',
  'int64',
  'int32',
  'uint',
  'uint32',
  'uint64',
]);

export const FLOAT_TYPES: ReadonlySet<string> = new Set(['float', 'float32', 'float64']);

export const COMMA_ARRAY_TYPES: ReadonlySet<string> = new Set([
  'Bits',
  'Encoding',
  'CommaSepList',
  'DumpFlags',
]);

export const ARRAY_TYPES: ReadonlySet<string> = new Set([
  '[]string',
  'List',
  'CommaSepList',
  'SpaceSepList',
  '[]int',
  '[]bool',
  'stringArray',
  'Bits',
  'Encoding',
  'DumpFlags',
]);

export const MULTISELECT_TYPES: ReadonlySet<string> = new Set([
  ...COMMA_ARRAY_TYPES,
  'SpaceSepList',
  'stringArray',
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

export function isCommaArrayType(type: string): boolean {
  return COMMA_ARRAY_TYPES.has(type);
}

export function isMultiselectType(type: string): boolean {
  return MULTISELECT_TYPES.has(type);
}

export function isConvertibleType(type: string): boolean {
  return CONVERTIBLE_TYPES.has(type);
}

export function isTristateType(type: string): boolean {
  return TRISTATE_TYPES.has(type);
}
