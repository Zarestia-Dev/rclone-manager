import { describe, it, expect } from 'vitest';
import {
  MASK,
  countLines,
  firstLines,
  formatCell,
  highlightJson,
  isSecretKey,
  lineHasSecret,
  maskSecrets,
  toTable,
} from './rc-output.util';

describe('rc-output.util', () => {
  describe('isSecretKey', () => {
    it('catches the usual credential keys', () => {
      for (const key of [
        'password',
        'pass',
        'token',
        'client_secret',
        'secret_access_key',
        'api_key',
        'access_key_id',
        'Authorization',
      ]) {
        expect(isSecretKey(key), key).toBe(true);
      }
    });

    it('leaves look-alikes alone', () => {
      for (const key of ['bypass', 'fs', 'type', 'oauth_status', 'author', 'key', 'remote']) {
        expect(isSecretKey(key), key).toBe(false);
      }
    });
  });

  describe('maskSecrets', () => {
    it('masks at any depth without touching the input', () => {
      const input = {
        mydrive: { type: 'drive', token: '{"access_token":"x"}', nested: [{ pass: 'p' }] },
        empty: { password: '' },
        count: 3,
      };
      const out = maskSecrets(input) as typeof input;
      expect(out.mydrive.token).toBe(MASK);
      expect(out.mydrive.nested[0]).toEqual({ pass: MASK });
      expect(out.mydrive.type).toBe('drive');
      expect(out.empty.password).toBe('');
      expect(input.mydrive.token).toBe('{"access_token":"x"}');
    });

    it('passes scalars and null through', () => {
      expect(maskSecrets(null)).toBeNull();
      expect(maskSecrets('token')).toBe('token');
    });
  });

  describe('maskSecrets with jsonText', () => {
    it('masks JSON that key=value carries as text', () => {
      const out = maskSecrets(
        {
          parameters: '{"secret_access_key":"abc","region":"eu"}',
          fs: 'drive:',
        },
        true
      ) as Record<string, string>;
      expect(JSON.parse(out['parameters'])).toEqual({ secret_access_key: MASK, region: 'eu' });
      expect(out['fs']).toBe('drive:');
    });

    it('leaves text that holds no secret exactly as it was', () => {
      const parameters = '{ "region": "eu" }';
      expect(maskSecrets({ parameters }, true)).toEqual({ parameters });
    });

    it('leaves text that only looks like JSON alone', () => {
      expect(maskSecrets({ note: '{not json' }, true)).toEqual({ note: '{not json' });
    });

    it('masks values that are not strings', () => {
      expect(maskSecrets({ main: { password: 123 } }, true)).toEqual({ main: { password: MASK } });
    });
  });

  describe('lineHasSecret', () => {
    it('detects key=value and JSON secrets', () => {
      expect(lineHasSecret('config/create name=x pass=hunter2')).toBe(true);
      expect(lineHasSecret(`config/create --json '{"password": "x"}'`)).toBe(true);
      expect(lineHasSecret('operations/list fs=drive:')).toBe(false);
    });

    it('finds the key whatever quoting hides the value', () => {
      expect(lineHasSecret('config/create password="a \\"b\\" c"')).toBe(true);
    });
  });

  describe('toTable', () => {
    it('tables a list of objects wrapped in one member', () => {
      const table = toTable({
        list: [
          { Name: 'a', Size: 1 },
          { Name: 'b', IsDir: true },
        ],
      });
      expect(table?.columns).toEqual(['Name', 'Size', 'IsDir']);
      expect(table?.rows).toHaveLength(2);
      expect(table?.omitted).toBe(0);
    });

    it('tables a bare list and caps the rows', () => {
      const rows = Array.from({ length: 1005 }, (_, i) => ({ i }));
      const table = toTable(rows);
      expect(table?.rows).toHaveLength(1000);
      expect(table?.omitted).toBe(5);
    });

    it('keeps every column of a wide list', () => {
      const row = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`c${i}`, i]));
      expect(toTable([row])?.columns).toHaveLength(30);
    });

    it('returns null for anything that is not a list of objects', () => {
      expect(toTable({ version: 'v1' })).toBeNull();
      expect(toTable([1, 2])).toBeNull();
      expect(toTable([])).toBeNull();
      expect(toTable({ a: [{ x: 1 }], b: [{ y: 2 }] })).toBeNull();
      expect(toTable('text')).toBeNull();
    });
  });

  describe('formatCell', () => {
    it('formats scalars, objects and long text', () => {
      expect(formatCell(null)).toBe('');
      expect(formatCell(5)).toBe('5');
      expect(formatCell({ a: 1 })).toBe('{"a":1}');
      expect(formatCell('x'.repeat(100))).toHaveLength(81);
    });
  });

  describe('highlightJson', () => {
    it('tags keys, strings, numbers, booleans and null, and loses no text', () => {
      const text = '{\n  "a": "b",\n  "n": -1.5e3,\n  "t": true,\n  "z": null\n}';
      const segments = highlightJson(text);
      expect(segments.map(s => s.text).join('')).toBe(text);
      const kind = (t: string): string | undefined => segments.find(s => s.text === t)?.kind;
      expect(kind('"a"')).toBe('key');
      expect(kind('"b"')).toBe('string');
      expect(kind('-1.5e3')).toBe('number');
      expect(kind('true')).toBe('bool');
      expect(kind('null')).toBe('null');
    });

    it('keeps escaped quotes inside one string', () => {
      const [, str] = highlightJson('["a\\"b"]');
      expect(str).toEqual({ text: '"a\\"b"', kind: 'string' });
    });

    it('returns plain text for non-JSON', () => {
      expect(highlightJson('hello')).toEqual([{ text: 'hello', kind: 'plain' }]);
    });
  });

  describe('countLines / firstLines', () => {
    const samples = ['', 'a', 'a\n', 'a\nb', 'a\nb\nc', '\n\n', 'x\n\ny'];

    it('count the lines the way split does', () => {
      for (const text of samples)
        expect(countLines(text), JSON.stringify(text)).toBe(text.split('\n').length);
    });

    it('cut the first lines the way split and join do', () => {
      for (const text of samples) {
        for (const limit of [1, 2, 3, 10]) {
          expect(firstLines(text, limit), `${JSON.stringify(text)} / ${limit}`).toBe(
            text.split('\n').slice(0, limit).join('\n')
          );
        }
      }
    });
  });
});
