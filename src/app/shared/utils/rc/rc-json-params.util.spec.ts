import { describe, it, expect } from 'vitest';
import { addParamKey, jsonObjectOrNull } from './rc-json-params.util';

describe('rc-json-params.util', () => {
  describe('jsonObjectOrNull', () => {
    it('reads an object, and blank text as an empty one', () => {
      expect(jsonObjectOrNull('{"a":1}')).toEqual({ a: 1 });
      expect(jsonObjectOrNull('')).toEqual({});
      expect(jsonObjectOrNull('  \n')).toEqual({});
    });

    it('gives null for anything that is not a JSON object', () => {
      expect(jsonObjectOrNull('{broken')).toBeNull();
      expect(jsonObjectOrNull('[1]')).toBeNull();
      expect(jsonObjectOrNull('"text"')).toBeNull();
      expect(jsonObjectOrNull('null')).toBeNull();
      expect(jsonObjectOrNull('{"fs":"{{prev.path}}')).toBeNull();
    });

    it('keeps an object that happens to look like a parse error', () => {
      expect(jsonObjectOrNull('{"ok":false,"error":"x"}')).toEqual({ ok: false, error: 'x' });
    });
  });

  describe('addParamKey', () => {
    it('starts an object from empty text', () => {
      expect(addParamKey('', 'fs')).toBe('{\n  "fs": ""\n}');
      expect(addParamKey('  ', 'fs')).toBe('{\n  "fs": ""\n}');
    });

    it('adds a key and keeps the others', () => {
      expect(JSON.parse(addParamKey('{"fs":"a:"}', 'remote'))).toEqual({ fs: 'a:', remote: '' });
    });

    it('does not overwrite a key that is already there', () => {
      const raw = '{"fs":"a:"}';
      expect(addParamKey(raw, 'fs')).toBe(raw);
    });

    it('leaves text it cannot read as JSON alone', () => {
      expect(addParamKey('{"fs":"{{prev.path}}', 'x')).toBe('{"fs":"{{prev.path}}');
      expect(addParamKey('[1]', 'x')).toBe('[1]');
      expect(addParamKey('"text"', 'x')).toBe('"text"');
    });
  });
});
