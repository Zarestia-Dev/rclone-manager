export const INT_TYPES: ReadonlySet<string> = new Set([
  'int',
  'int64',
  'int32',
  'uint',
  'uint32',
  'uint64',
]);

export const FLOAT_TYPES: ReadonlySet<string> = new Set(['float', 'float32', 'float64']);

export const ARRAY_TYPES: ReadonlySet<string> = new Set([
  '[]string',
  'List',
  'CommaSepList',
  '[]int',
  '[]bool',
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

export function isTristateType(type: string): boolean {
  return TRISTATE_TYPES.has(type);
}
