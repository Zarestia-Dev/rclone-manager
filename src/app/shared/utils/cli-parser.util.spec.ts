import {
  tokenize,
  hasMacro,
  stripQuotes,
  isRcloneBinary,
  isFlagToken,
  parseCLI,
} from './cli-parser.util';

describe('cli-parser.util', () => {
  describe('tokenize', () => {
    it('splits CLI by spaces', () => {
      expect(tokenize('rclone sync source:path dest:path')).toEqual([
        'rclone',
        'sync',
        'source:path',
        'dest:path',
      ]);
    });

    it('respects double and single quotes', () => {
      expect(tokenize('rclone copy "source path" \'dest path\'')).toEqual([
        'rclone',
        'copy',
        'source path',
        'dest path',
      ]);
    });

    it('handles backslash line continuations', () => {
      expect(tokenize('rclone copy \\\n  src: \\\n  dst:')).toEqual([
        'rclone',
        'copy',
        'src:',
        'dst:',
      ]);
    });

    it('preserves spaces in subshells and backticks', () => {
      expect(tokenize('rclone sync src: /backup/$(date +%Y-%m-%d) `echo test`')).toEqual([
        'rclone',
        'sync',
        'src:',
        '/backup/$(date +%Y-%m-%d)',
        '`echo test`',
      ]);
    });

    it('ignores comments starting with #', () => {
      expect(tokenize('rclone sync src: dst: # this is a comment\n--dry-run')).toEqual([
        'rclone',
        'sync',
        'src:',
        'dst:',
        '--dry-run',
      ]);
    });
  });

  describe('hasMacro', () => {
    it('detects macro expansions', () => {
      expect(hasMacro('backup_$(date +%s)')).toBe(true);
      expect(hasMacro('backup_`date`')).toBe(true);
      expect(hasMacro('backup_normal')).toBe(false);
    });
  });

  describe('stripQuotes', () => {
    it('strips surrounding quotes', () => {
      expect(stripQuotes('"hello"')).toBe('hello');
      expect(stripQuotes("'hello'")).toBe('hello');
      expect(stripQuotes('hello')).toBe('hello');
      expect(stripQuotes('"')).toBe('"');
    });
  });

  describe('isRcloneBinary & isFlagToken', () => {
    it('detects rclone executable names', () => {
      expect(isRcloneBinary('rclone')).toBe(true);
      expect(isRcloneBinary('rclone.exe')).toBe(true);
      expect(isRcloneBinary('/usr/bin/rclone')).toBe(true);
      expect(isRcloneBinary('C:\\bin\\rclone.exe')).toBe(true);
      expect(isRcloneBinary('rsync')).toBe(false);
    });

    it('detects flag tokens', () => {
      expect(isFlagToken('--dry-run')).toBe(true);
      expect(isFlagToken('-v')).toBe(true);
      expect(isFlagToken('-vvv')).toBe(true);
      expect(isFlagToken('-')).toBe(false);
      expect(isFlagToken('src:')).toBe(false);
    });
  });

  describe('parseCLI', () => {
    const bools = new Set(['dry-run', 'progress', 'verbose']);

    it('parses verbs, paths, and flags', () => {
      const cli = 'rclone sync /src /dst --dry-run --bwlimit=10M';
      const parsed = parseCLI(cli, bools);
      expect(parsed.verb).toBe('sync');
      expect(parsed.sourcePath).toBe('/src');
      expect(parsed.destPath).toBe('/dst');
      expect(parsed.flags.length).toBe(2);
      expect(parsed.flags[0].key).toBe('dry-run');
      expect(parsed.flags[0].value).toBe(true);
      expect(parsed.flags[1].key).toBe('bwlimit');
      expect(parsed.flags[1].value).toBe('10M');
    });

    it('handles wrappers like sudo', () => {
      const cli = 'sudo rclone copy /src /dst -P';
      const parsed = parseCLI(cli, bools);
      expect(parsed.verb).toBe('copy');
      expect(parsed.sourcePath).toBe('/src');
      expect(parsed.destPath).toBe('/dst');
      expect(parsed.flags[0].key).toBe('P');
      expect(parsed.flags[0].value).toBe(true);
    });

    it('parses mount and mountSubtypes', () => {
      const cli = 'rclone cmount remote: /mnt/remote';
      const parsed = parseCLI(cli, bools);
      expect(parsed.verb).toBe('mount');
      expect(parsed.mountSubtype).toBe('cmount');
    });

    it('detects macros in flag values', () => {
      const cli = 'rclone copy src: dst: --log-file=/logs/$(date).log';
      const parsed = parseCLI(cli, bools);
      expect(parsed.flags[0].hasMacro).toBe(true);
    });
  });
});
