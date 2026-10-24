import { describe, expect, it } from 'vitest';
import { isArrayType, isJsonArrayType } from './rclone-types.util';

describe('rclone array option types', () => {
  it.each([
    { type: 'stringArray', json: true },
    { type: '[]string', json: true },
    { type: 'List', json: true },
    { type: '[]int', json: true },
    { type: '[]bool', json: true },
    { type: 'CommaSepList', json: true },
    { type: 'Bits', json: false },
    { type: 'Encoding', json: false },
    { type: 'DumpFlags', json: false },
    { type: 'SpaceSepList', json: true },
  ])('recognizes $type while preserving its serialization format', ({ type, json }) => {
    expect(isArrayType(type)).toBe(true);
    expect(isJsonArrayType(type)).toBe(json);
  });

  it.each(['', 'string', 'bool', 'int', 'unknown', 'list'])(
    'does not treat %s as an array option',
    type => {
      expect(isArrayType(type)).toBe(false);
      expect(isJsonArrayType(type)).toBe(false);
    }
  );
});
