import { describe, it, expect } from 'vitest';
import { RcCommandInfo } from '@app/types';
import { MASK } from './rc-output.util';
import {
  commandName,
  commandPrefix,
  computeSuggestions,
  formatCommandLine,
  isDangerousCommand,
  isReadOnlyCommand,
  maskCommandLine,
  normalizeCommand,
  parseJsonObject,
  parseRcCommandLine,
  pushUnique,
  quoteToken,
  RcSuggestion,
  suggestCommands,
  usedParamKeys,
  tokenizeRcLine,
} from './rc-console.util';

const info = (Path: string): RcCommandInfo => ({ Path, Title: '', Help: '' });

describe('rc-console.util', () => {
  describe('tokenizeRcLine', () => {
    it('splits on whitespace and honours quotes', () => {
      expect(tokenizeRcLine(`a b="c d" 'e f'`)).toEqual(['a', 'b=c d', 'e f']);
    });

    it('keeps an empty quoted value as a token', () => {
      expect(tokenizeRcLine(`a ""`)).toEqual(['a', '']);
    });

    describe('Windows paths', () => {
      it('keeps drive paths and UNC paths exactly as typed', () => {
        expect(tokenizeRcLine('fs=C:\\Users\\me')).toEqual(['fs=C:\\Users\\me']);
        expect(tokenizeRcLine('fs=\\\\server\\share\\dir remote=x')).toEqual([
          'fs=\\\\server\\share\\dir',
          'remote=x',
        ]);
        expect(tokenizeRcLine('fs="\\\\server\\share"')).toEqual(['fs=\\\\server\\share']);
        expect(tokenizeRcLine('fs="C:\\\\My Files"')).toEqual(['fs=C:\\\\My Files']);
      });

      it('does not let a trailing backslash swallow the space after it', () => {
        expect(tokenizeRcLine('fs=C:\\ remote=x')).toEqual(['fs=C:\\', 'remote=x']);
      });

      it('needs the backslash doubled at the end of a quoted path, as Windows does', () => {
        expect(tokenizeRcLine('fs="C:\\My Files\\\\" remote=x')).toEqual([
          'fs=C:\\My Files\\',
          'remote=x',
        ]);
        expect(tokenizeRcLine('a="C:\\\\" b="D:\\\\"')).toEqual(['a=C:\\', 'b=D:\\']);
      });

      it('reports an undoubled one as an unclosed quote, never as a wrong path', () => {
        expect(tokenizeRcLine('fs="C:\\"')).toBeNull();
        expect(tokenizeRcLine('fs="C:\\My Files\\" remote=x')).toBeNull();
      });
    });

    describe('escaped quotes', () => {
      it('treats a backslash before a double quote as an escape', () => {
        expect(tokenizeRcLine('"c\\"d" e\\"f')).toEqual(['c"d', 'e"f']);
        expect(tokenizeRcLine('p="{\\"a\\":1}"')).toEqual(['p={"a":1}']);
      });

      it('halves the backslashes before a quote, as Windows does', () => {
        expect(tokenizeRcLine('"a\\\\\\"b"')).toEqual(['a\\"b']); // three: one backslash, literal quote
        expect(tokenizeRcLine('"a\\\\" b')).toEqual(['a\\', 'b']); // two: one backslash, closing quote
      });

      it('does not unescape inside single quotes', () => {
        expect(tokenizeRcLine(`'a\\"b'`)).toEqual(['a\\"b']);
        expect(tokenizeRcLine(`'C:\\'`)).toEqual(['C:\\']);
      });
    });

    it('no longer reads a backslash as an escaped space', () => {
      expect(tokenizeRcLine('a\\ b')).toEqual(['a\\', 'b']);
    });

    it('returns null for an unclosed quote', () => {
      expect(tokenizeRcLine(`a "b`)).toBeNull();
    });

    it('returns an empty list for blank input', () => {
      expect(tokenizeRcLine('   ')).toEqual([]);
    });
  });

  describe('parseRcCommandLine', () => {
    it('parses a bare command', () => {
      expect(parseRcCommandLine('core/version')).toEqual({
        ok: true,
        value: { command: 'core/version', params: {} },
      });
    });

    it('strips slashes around the command', () => {
      const res = parseRcCommandLine('/core/version/');
      expect(res.ok && res.value.command).toBe('core/version');
    });

    it('sends key=value pairs as strings, splitting on the first equals sign', () => {
      const res = parseRcCommandLine('operations/list fs=drive: remote=a=b');
      expect(res.ok && res.value.params).toEqual({ fs: 'drive:', remote: 'a=b' });
    });

    it('accepts quoted values with spaces', () => {
      const res = parseRcCommandLine('operations/list fs="my drive:"');
      expect(res.ok && res.value.params).toEqual({ fs: 'my drive:' });
    });

    it('parses --json and --json=', () => {
      const a = parseRcCommandLine(`x/y --json '{"fs":"d:","n":1}'`);
      const b = parseRcCommandLine(`x/y --json='{"fs":"d:"}'`);
      expect(a.ok && a.value.params).toEqual({ fs: 'd:', n: 1 });
      expect(b.ok && b.value.params).toEqual({ fs: 'd:' });
    });

    it('accepts a bare JSON object after the command', () => {
      const res = parseRcCommandLine('x/y {"fs": "my drive:", "recurse": true}');
      expect(res.ok && res.value.params).toEqual({ fs: 'my drive:', recurse: true });
    });

    it('collects -o into opt and -a into arg, merging with --json', () => {
      const res = parseRcCommandLine(`core/command -a ls -a drive: -o max-depth=1 -o flag`);
      expect(res.ok && res.value.params).toEqual({
        arg: ['ls', 'drive:'],
        opt: { 'max-depth': '1', flag: '' },
      });
      const merged = parseRcCommandLine(`x/y --json '{"a":1}' -o k=v`);
      expect(merged.ok && merged.value.params).toEqual({ a: 1, opt: { k: 'v' } });
    });

    it('mixes --json with key=value, the pairs winning over the same key', () => {
      const res = parseRcCommandLine(`x/y a=b fs=new: --json '{"fs":"old:","n":1}'`);
      expect(res.ok && res.value.params).toEqual({ fs: 'new:', n: 1, a: 'b' });
    });

    it('reports invalid JSON and non-objects', () => {
      const bad = parseRcCommandLine('x/y {nope');
      expect(!bad.ok && bad.error.key).toBe('modals.rcConsole.errors.badJson');
      const arr = parseRcCommandLine(`x/y --json '[1]'`);
      expect(!arr.ok && arr.error.key).toBe('modals.rcConsole.errors.jsonNotObject');
    });

    it('reports a token without an equals sign', () => {
      const res = parseRcCommandLine('x/y fs');
      expect(res).toEqual({
        ok: false,
        error: { key: 'modals.rcConsole.errors.missingEquals', params: { token: 'fs' } },
      });
    });

    it('reports a flag with no value and an unclosed quote', () => {
      const flag = parseRcCommandLine('x/y -a');
      expect(!flag.ok && flag.error.key).toBe('modals.rcConsole.errors.missingValue');
      const quote = parseRcCommandLine('x/y a="b');
      expect(!quote.ok && quote.error.key).toBe('modals.rcConsole.errors.unclosedQuote');
    });

    it('reports an empty line', () => {
      const res = parseRcCommandLine('   ');
      expect(!res.ok && res.error.key).toBe('modals.rcConsole.errors.empty');
    });
  });

  describe('suggestCommands', () => {
    const commands = [
      info('core/version'),
      info('operations/list'),
      info('operations/lsd'),
      info('vfs/list'),
    ];

    it('puts prefix matches before substring matches', () => {
      expect(suggestCommands(commands, 'ope').map(c => c.Path)).toEqual([
        'operations/list',
        'operations/lsd',
      ]);
      expect(suggestCommands(commands, 'list').map(c => c.Path)).toEqual([
        'operations/list',
        'vfs/list',
      ]);
    });

    it('ignores case and a leading slash, and caps the result', () => {
      expect(suggestCommands(commands, '/CORE').map(c => c.Path)).toEqual(['core/version']);
      expect(suggestCommands(commands, 'o', 1)).toHaveLength(1);
    });

    it('returns nothing for an empty query', () => {
      expect(suggestCommands(commands, '  ')).toEqual([]);
    });
  });

  describe('commandPrefix', () => {
    it('returns the text while only the command is being typed', () => {
      expect(commandPrefix('')).toBe('');
      expect(commandPrefix(' op')).toBe('op');
    });

    it('returns null once arguments start', () => {
      expect(commandPrefix('operations/list ')).toBeNull();
      expect(commandPrefix('a b')).toBeNull();
    });
  });

  describe('isDangerousCommand', () => {
    it('flags destructive and daemon-stopping calls', () => {
      expect(isDangerousCommand('core/quit')).toBe(true);
      expect(isDangerousCommand('/operations/purge/')).toBe(true);
    });

    it('flags the calls that run or overwrite other things', () => {
      for (const command of [
        'job/batch',
        'backend/command',
        'sync/bisync',
        'operations/movefile',
        'config/update',
      ]) {
        expect(isDangerousCommand(command), command).toBe(true);
      }
    });

    it('lets read-only calls through', () => {
      expect(isDangerousCommand('core/version')).toBe(false);
      expect(isDangerousCommand('operations/list')).toBe(false);
    });
  });

  describe('normalizeCommand / commandName', () => {
    it('drops spaces and slashes around a call', () => {
      expect(normalizeCommand(' /core/version/ ')).toBe('core/version');
      expect(normalizeCommand('//')).toBe('');
    });

    it('takes the first word of a line', () => {
      expect(commandName('  /operations/list/ fs=a:')).toBe('operations/list');
      expect(commandName('core/ver')).toBe('core/ver');
      expect(commandName('   ')).toBe('');
    });
  });

  describe('parseJsonObject', () => {
    it('reads an object, whatever keys it has', () => {
      expect(parseJsonObject('{"ok":false,"error":"x"}')).toEqual({
        ok: true,
        value: { ok: false, error: 'x' },
      });
    });

    it('explains what is wrong with anything else', () => {
      const bad = parseJsonObject('{x');
      expect(!bad.ok && bad.error.key).toBe('modals.rcConsole.errors.badJson');
      const array = parseJsonObject('[1]');
      expect(!array.ok && array.error.key).toBe('modals.rcConsole.errors.jsonNotObject');
    });
  });

  describe('isReadOnlyCommand', () => {
    it('allows reads and blocks writes and unknown calls', () => {
      expect(isReadOnlyCommand('operations/list')).toBe(true);
      expect(isReadOnlyCommand('/core/version/')).toBe(true);
      expect(isReadOnlyCommand('operations/getfile')).toBe(true);
      expect(isReadOnlyCommand('operations/index')).toBe(false);
      expect(isReadOnlyCommand('sync/copy')).toBe(false);
      expect(isReadOnlyCommand('core/bwlimit')).toBe(false);
      expect(isReadOnlyCommand('made/up')).toBe(false);
    });

    it('never lists a dangerous call as read-only', () => {
      for (const command of [
        'core/quit',
        'operations/purge',
        'options/set',
        'sync/sync',
        'job/batch',
      ]) {
        expect(isDangerousCommand(command) && isReadOnlyCommand(command), command).toBe(false);
      }
    });
  });

  describe('computeSuggestions', () => {
    const commands = [info('operations/list'), info('operations/lsd')];
    const params = [
      { name: 'fs', description: 'a remote', optional: false },
      { name: 'remote', description: 'a path', optional: false },
      { name: 'opt', description: 'options', optional: true },
    ];
    const remotes = ['gdrive', 'dropbox'];
    const suggest = (line: string): RcSuggestion[] =>
      computeSuggestions({ line, commands, remotes, params });

    it('completes the command name with a trailing space', () => {
      const [first] = suggest('operations/l');
      expect(first).toMatchObject({
        kind: 'command',
        label: 'operations/list',
        line: 'operations/list ',
      });
    });

    it('offers no command once it is complete and unique', () => {
      expect(suggest('operations/lsd')).toEqual([]);
    });

    it('offers parameter names that are not used yet', () => {
      expect(suggest('operations/list re').map(s => s.line)).toEqual(['operations/list remote=']);
      expect(suggest('operations/list fs=a: f')).toEqual([]);
      expect(suggest('operations/list ').map(s => s.kind)).toEqual([]);
    });

    it('offers remotes after an fs-style key', () => {
      expect(suggest('operations/list fs=d').map(s => s.line)).toEqual([
        'operations/list fs=dropbox:',
      ]);
      expect(suggest('sync/copy srcFs=g').map(s => s.label)).toEqual(['gdrive:']);
    });

    it('does not suggest remotes for other keys or once a colon is typed', () => {
      expect(suggest('operations/list remote=d')).toEqual([]);
      expect(suggest('operations/list fs=dropbox:pa')).toEqual([]);
    });

    it('stays quiet inside quotes, JSON and flags', () => {
      expect(suggest('operations/list fs="d')).toEqual([]);
      expect(suggest('operations/list {"f')).toEqual([]);
      expect(suggest('operations/list --j')).toEqual([]);
    });
  });

  describe('quoteToken', () => {
    it('quotes only when needed', () => {
      expect(quoteToken('drive:')).toBe('drive:');
      expect(quoteToken('my drive:')).toBe('"my drive:"');
      expect(quoteToken('a"b')).toBe('"a\\"b"');
      expect(quoteToken('')).toBe('""');
    });

    it('leaves a Windows path alone unless it has a space', () => {
      expect(quoteToken('C:\\Users\\me')).toBe('C:\\Users\\me');
      expect(quoteToken('\\\\server\\share')).toBe('\\\\server\\share');
      expect(quoteToken('C:\\My Files\\')).toBe('"C:\\My Files\\\\"');
    });

    it('writes values that tokenizeRcLine reads back unchanged', () => {
      for (const value of [
        'C:\\',
        'C:\\My Files\\',
        '\\\\server\\share dir\\',
        'a"b',
        'a\\"b',
        'a\\\\"b c',
        'say "hi" \\',
        "it's mine",
        '"',
        '\\',
        '\\\\',
        '',
        ' ',
      ]) {
        expect(tokenizeRcLine(`k=${quoteToken(value)}`), JSON.stringify(value)).toEqual([
          `k=${value}`,
        ]);
      }
    });
  });

  describe('formatCommandLine / maskCommandLine', () => {
    const mask = (line: string): string => {
      const parsed = parseRcCommandLine(line);
      if (!parsed.ok) throw new Error('did not parse');
      return maskCommandLine(line, parsed.value);
    };

    it('writes opt, arg and JSON parameters the way the parser reads them', () => {
      const line = formatCommandLine('core/command', {
        command: 'ls',
        opt: { 'max-depth': '1' },
        arg: ['drive:', 'my dir'],
        parameters: { a: 1 },
      });
      expect(line).toBe(
        'core/command command=ls -o max-depth=1 -a drive: -a "my dir" parameters="{\\"a\\":1}"'
      );
      const parsed = parseRcCommandLine(line);
      expect(parsed.ok && parsed.value.params).toEqual({
        command: 'ls',
        opt: { 'max-depth': '1' },
        arg: ['drive:', 'my dir'],
        parameters: '{"a":1}',
      });
    });

    it('writes Windows paths so they parse back unchanged', () => {
      const params = { fs: 'C:\\My Files\\', remote: '\\\\server\\share', opt: { a: 'x y' } };
      const parsed = parseRcCommandLine(formatCommandLine('operations/list', params));
      expect(parsed.ok && parsed.value.params).toEqual({
        fs: 'C:\\My Files\\',
        remote: '\\\\server\\share',
        opt: { a: 'x y' },
      });
    });

    it('returns a clean line exactly as it was typed', () => {
      expect(mask('operations/list   fs=drive:   remote=""')).toBe(
        'operations/list   fs=drive:   remote=""'
      );
    });

    it('masks plain key=value secrets', () => {
      expect(mask('config/create name=x pass=hunter2 type=sftp')).toBe(
        `config/create name=x pass=${MASK} type=sftp`
      );
    });

    it('masks a secret whose value has escaped quotes, which a pattern would cut short', () => {
      const out = mask('config/create name=x password="a \\"b\\" c"');
      expect(out).toBe(`config/create name=x password=${MASK}`);
      expect(out).not.toContain('b');
    });

    it('masks a secret value that holds spaces inside JSON', () => {
      const out = mask(`config/create name=x token='{"access_token":"a b"}'`);
      expect(out).toBe(`config/create name=x token=${MASK}`);
    });

    it('masks secrets inside JSON given as text, as --json and with -o', () => {
      const parameters = mask(`config/create name=x parameters='{"secret_access_key":"abc"}'`);
      expect(parameters).not.toContain('abc');
      expect(parameters).toContain(MASK);
      const json = mask(`options/set --json '{"main":{"password":123}}'`);
      expect(json).not.toContain('123');
      const opt = mask('core/command -a ls -o password=abc');
      expect(opt).toBe(`core/command -o password=${MASK} -a ls`);
    });
  });

  describe('pushUnique', () => {
    it('moves a repeated line to the end and caps the list', () => {
      expect(pushUnique(['a', 'b'], 'a', 5)).toEqual(['b', 'a']);
      expect(pushUnique(['a', 'b', 'c'], 'd', 3)).toEqual(['b', 'c', 'd']);
      expect(pushUnique(['a'], '  ', 3)).toEqual(['a']);
    });
  });

  describe('usedParamKeys', () => {
    it('lists the keys already typed, wherever they are on the line', () => {
      expect([...usedParamKeys('operations/list fs=a: remote=b opt.recurse=true')]).toEqual([
        'fs',
        'remote',
        'opt.recurse',
      ]);
    });

    it('ignores the command, values and flags', () => {
      expect(usedParamKeys('operations/list').size).toBe(0);
      expect([...usedParamKeys('x/y -o max-depth=1 a=b=c')]).toEqual(['max-depth', 'a']);
    });
  });
});
