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

describe('tokenize', () => {
  it('should split raw CLI by spaces', () => {
    const tokens = tokenize('rclone sync source:path dest:path');
    expect(tokens).toEqual(['rclone', 'sync', 'source:path', 'dest:path']);
  });

  it('should respect double and single quotes', () => {
    const tokens = tokenize('rclone sync "source path" \'dest path\'');
    expect(tokens).toEqual(['rclone', 'sync', 'source path', 'dest path']);
  });

  it('should handle backslash line continuations', () => {
    const tokens = tokenize('rclone sync \\\n  source:path \\\n  dest:path');
    expect(tokens).toEqual(['rclone', 'sync', 'source:path', 'dest:path']);
  });

  it('should not split on spaces inside subshells or backticks', () => {
    const tokens = tokenize(
      'rclone sync src: /backup/local_$(date +%Y-%m-%d_%H%M) --msg `hello world`'
    );
    expect(tokens).toEqual([
      'rclone',
      'sync',
      'src:',
      '/backup/local_$(date +%Y-%m-%d_%H%M)',
      '--msg',
      '`hello world`',
    ]);
  });
});
describe('hasMacro', () => {
  it('should detect $(...) macro patterns', () => {
    expect(hasMacro('dest:/archive/pCloud_$(date +%Y-%m-%d)')).toBe(true);
  });

  it('should detect `...` macro patterns', () => {
    expect(hasMacro('dest:/archive/pCloud_`date`')).toBe(true);
  });

  it('should return false for strings without macros', () => {
    expect(hasMacro('dest:/archive/pCloud_normal')).toBe(false);
  });
});
describe('parse', () => {
  it('should parse verb, sourcePath, destPath and key/value flags', () => {
    const existingBools = new Set(['track-renames']);
    const parsed = parseCLI(
      'rclone sync source:path dest:path --max-delete 50 --track-renames',
      existingBools
    );

    expect(parsed.verb).toBe('sync');
    expect(parsed.sourcePath).toBe('source:path');
    expect(parsed.destPath).toBe('dest:path');

    expect(parsed.flags.length).toBe(2);
    expect(parsed.flags[0]).toEqual({
      raw: '--max-delete 50',
      key: 'max-delete',
      value: '50',
      hasMacro: false,
    });
    expect(parsed.flags[1]).toEqual({
      raw: '--track-renames',
      key: 'track-renames',
      value: true,
      hasMacro: false,
    });
  });

  it('should parse boolean flags with underscore-hyphen normalization', () => {
    const existingBools = new Set(['track_renames']);
    const parsed = parseCLI('rclone sync source:path dest:path --track-renames', existingBools);
    expect(parsed.flags[0]).toEqual({
      raw: '--track-renames',
      key: 'track-renames',
      value: true,
      hasMacro: false,
    });
  });

  it('should handle equal sign in flags', () => {
    const parsed = parseCLI(
      'rclone sync source:path dest:path --backup-dir=dest:/archive',
      new Set()
    );
    expect(parsed.flags[0]).toEqual({
      raw: '--backup-dir=dest:/archive',
      key: 'backup-dir',
      value: 'dest:/archive',
      hasMacro: false,
    });
  });

  it('should strip quotes from equal sign values in flags', () => {
    const parsed = parseCLI(
      'rclone sync source:path dest:path --exclude-from="/path/to/exclude-list.txt"',
      new Set()
    );
    expect(parsed.flags[0]).toEqual({
      raw: '--exclude-from="/path/to/exclude-list.txt"',
      key: 'exclude-from',
      value: '/path/to/exclude-list.txt',
      hasMacro: false,
    });
  });

  it('should parse mount verb and its paths', () => {
    const parsed = parseCLI('rclone mount remote:path /mnt/point --vfs-cache-mode full', new Set());
    expect(parsed.verb).toBe('mount');
    expect(parsed.mountSubtype).toBe('mount');
    expect(parsed.sourcePath).toBe('remote:path');
    expect(parsed.destPath).toBe('/mnt/point');
    expect(parsed.flags[0].key).toBe('vfs-cache-mode');
    expect(parsed.flags[0].value).toBe('full');
  });

  it('should parse mount2/cmount/nfsmount verbs mapping to mount operation', () => {
    const parsed2 = parseCLI('rclone mount2 remote:path /mnt/point', new Set());
    expect(parsed2.verb).toBe('mount');
    expect(parsed2.mountSubtype).toBe('mount2');

    const parsedC = parseCLI('rclone cmount remote:path /mnt/point', new Set());
    expect(parsedC.verb).toBe('mount');
    expect(parsedC.mountSubtype).toBe('cmount');

    const parsedN = parseCLI('rclone nfsmount remote:path /mnt/point', new Set());
    expect(parsedN.verb).toBe('mount');
    expect(parsedN.mountSubtype).toBe('nfsmount');
  });

  it('should parse serve verb, serveSubtype, and source path', () => {
    const parsed = parseCLI('rclone serve http remote:path --addr :8080', new Set());
    expect(parsed.verb).toBe('serve');
    expect(parsed.serveSubtype).toBe('http');
    expect(parsed.sourcePath).toBe('remote:path');
    expect(parsed.destPath).toBeUndefined();
    expect(parsed.flags[0].key).toBe('addr');
    expect(parsed.flags[0].value).toBe(':8080');
  });
});
