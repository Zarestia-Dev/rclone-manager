import { TestBed } from '@angular/core/testing';
import { CliFlagMapperService, ParsedCLI } from './cli-flag-mapper.service';
import { PathService } from '../infrastructure/platform/path.service';
import { RcConfigOption } from '@app/types';

describe('CliFlagMapperService', () => {
  let service: CliFlagMapperService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [CliFlagMapperService, PathService],
    });
    service = TestBed.inject(CliFlagMapperService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('tokenize', () => {
    it('should split raw CLI by spaces', () => {
      const tokens = service.tokenize('rclone sync source:path dest:path');
      expect(tokens).toEqual(['rclone', 'sync', 'source:path', 'dest:path']);
    });

    it('should respect double and single quotes', () => {
      const tokens = service.tokenize('rclone sync "source path" \'dest path\'');
      expect(tokens).toEqual(['rclone', 'sync', 'source path', 'dest path']);
    });

    it('should handle backslash line continuations', () => {
      const tokens = service.tokenize('rclone sync \\\n  source:path \\\n  dest:path');
      expect(tokens).toEqual(['rclone', 'sync', 'source:path', 'dest:path']);
    });

    it('should not split on spaces inside subshells or backticks', () => {
      const tokens = service.tokenize(
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
      expect(service.hasMacro('dest:/archive/pCloud_$(date +%Y-%m-%d)')).toBeTrue();
    });

    it('should detect `...` macro patterns', () => {
      expect(service.hasMacro('dest:/archive/pCloud_`date`')).toBeTrue();
    });

    it('should return false for strings without macros', () => {
      expect(service.hasMacro('dest:/archive/pCloud_normal')).toBeFalse();
    });
  });

  describe('parse', () => {
    it('should parse verb, sourcePath, destPath and key/value flags', () => {
      const existingBools = new Set(['track-renames']);
      const parsed = service.parse(
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
      const parsed = service.parse(
        'rclone sync source:path dest:path --track-renames',
        existingBools
      );
      expect(parsed.flags[0]).toEqual({
        raw: '--track-renames',
        key: 'track-renames',
        value: true,
        hasMacro: false,
      });
    });

    it('should handle equal sign in flags', () => {
      const parsed = service.parse(
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
      const parsed = service.parse(
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
      const parsed = service.parse(
        'rclone mount remote:path /mnt/point --vfs-cache-mode full',
        new Set()
      );
      expect(parsed.verb).toBe('mount');
      expect(parsed.mountSubtype).toBe('mount');
      expect(parsed.sourcePath).toBe('remote:path');
      expect(parsed.destPath).toBe('/mnt/point');
      expect(parsed.flags[0].key).toBe('vfs-cache-mode');
      expect(parsed.flags[0].value).toBe('full');
    });

    it('should parse mount2/cmount/nfsmount verbs mapping to mount operation', () => {
      const parsed2 = service.parse('rclone mount2 remote:path /mnt/point', new Set());
      expect(parsed2.verb).toBe('mount');
      expect(parsed2.mountSubtype).toBe('mount2');

      const parsedC = service.parse('rclone cmount remote:path /mnt/point', new Set());
      expect(parsedC.verb).toBe('mount');
      expect(parsedC.mountSubtype).toBe('cmount');

      const parsedN = service.parse('rclone nfsmount remote:path /mnt/point', new Set());
      expect(parsedN.verb).toBe('mount');
      expect(parsedN.mountSubtype).toBe('nfsmount');
    });

    it('should parse serve verb, serveSubtype, and source path', () => {
      const parsed = service.parse('rclone serve http remote:path --addr :8080', new Set());
      expect(parsed.verb).toBe('serve');
      expect(parsed.serveSubtype).toBe('http');
      expect(parsed.sourcePath).toBe('remote:path');
      expect(parsed.destPath).toBeUndefined();
      expect(parsed.flags[0].key).toBe('addr');
      expect(parsed.flags[0].value).toBe(':8080');
    });
  });

  describe('classify', () => {
    // Note: rclone RC API uses underscores in Name (e.g. "max_delete"), CLI uses hyphens (--max-delete)
    const mockFields: Record<string, RcConfigOption[]> = {
      sync: [
        {
          Name: 'max_delete',
          FieldName: 'MaxDelete',
          Type: 'int',
          DefaultStr: '-1',
          Help: '',
        },
        {
          Name: 'track_renames',
          FieldName: 'TrackRenames',
          Type: 'bool',
          DefaultStr: 'false',
          Help: '',
        },
      ],
    };

    it('should match --max-delete (hyphen) against max_delete (underscore) from RC API', () => {
      const lookupTable = service.buildLookupTable(mockFields as any);
      const parsed: ParsedCLI = {
        verb: 'sync',
        sourcePath: 'src:',
        destPath: 'dst:',
        flags: [
          { raw: '--max-delete 50', key: 'max-delete', value: '50', hasMacro: false },
          { raw: '--track-renames', key: 'track-renames', value: true, hasMacro: false },
          { raw: '--unknown-flag', key: 'unknown-flag', value: 'val', hasMacro: false },
        ],
      };

      const result = service.classify(parsed, lookupTable);

      expect(result.verb).toBe('sync');
      expect(result.sourcePath).toBe('src:');
      expect(result.destPath).toBe('dst:');

      expect(result.classified[0].status).toBe('mapped');
      expect(result.classified[0].fieldName).toBe('MaxDelete');
      expect(result.classified[0].coercedValue).toBe(50);

      expect(result.classified[1].status).toBe('mapped');
      expect(result.classified[1].fieldName).toBe('TrackRenames');

      expect(result.classified[2].status).toBe('unknown');
    });

    it('should coerce uint and float types', () => {
      const lookupTable = service.buildLookupTable({
        sync: [
          { Name: 'tpslimit', FieldName: 'TpsLimit', Type: 'float64' } as any,
          { Name: 'tpslimit-burst', FieldName: 'TpsLimitBurst', Type: 'uint32' } as any,
        ],
      } as any);

      const parsed: ParsedCLI = {
        verb: 'sync',
        sourcePath: 'src:',
        destPath: 'dst:',
        flags: [
          { raw: '--tpslimit 10.5', key: 'tpslimit', value: '10.5', hasMacro: false },
          { raw: '--tpslimit-burst 12', key: 'tpslimit-burst', value: '12', hasMacro: false },
        ],
      };

      const result = service.classify(parsed, lookupTable);
      expect(result.classified[0].coercedValue).toBe(10.5);
      expect(result.classified[1].coercedValue).toBe(12);
    });

    it('should match runtimeRemote specific prefixed options if remoteType is provided', () => {
      const mockFieldsWithRuntime: Record<string, RcConfigOption[]> = {
        runtimeRemote: [
          {
            Name: 'provider',
            FieldName: 'Provider',
            Type: 'string',
            DefaultStr: '',
            Help: '',
          },
          {
            Name: 'chunk_size',
            FieldName: 'ChunkSize',
            Type: 'string',
            DefaultStr: '',
            Help: '',
          },
        ],
      };

      const lookupTable = service.buildLookupTable(mockFieldsWithRuntime as any, 's3');
      const parsed: ParsedCLI = {
        verb: 'serve',
        flags: [
          { raw: '--s3-provider AWS', key: 's3-provider', value: 'AWS', hasMacro: false },
          { raw: '--s3-chunk-size 64M', key: 's3-chunk-size', value: '64M', hasMacro: false },
        ],
      };

      const result = service.classify(parsed, lookupTable);
      expect(result.classified[0].status).toBe('mapped');
      expect(result.classified[0].fieldName).toBe('Provider');
      expect(result.classified[0].coercedValue).toBe('AWS');

      expect(result.classified[1].status).toBe('mapped');
      expect(result.classified[1].fieldName).toBe('ChunkSize');
      expect(result.classified[1].coercedValue).toBe('64M');
    });

    it('should strip bash-style comments', () => {
      // Line continuation (\) + newline joins the lines, then # starts a comment
      // that runs to the end of the line.
      const tokens = service.tokenize(
        'rclone sync src: dst: --filter "- /**" \\\n# comment\n --addr :8080'
      );
      expect(tokens).toEqual([
        'rclone',
        'sync',
        'src:',
        'dst:',
        '--filter',
        '- /**',
        '--addr',
        ':8080',
      ]);
    });

    it('should consume flag values starting with hyphen but not forming valid flags', () => {
      const parsed = service.parse(
        'rclone sync src: dst: --filter "- /**" --max-delete -10',
        new Set()
      );
      expect(parsed.flags[0]).toEqual({
        raw: '--filter - /**',
        key: 'filter',
        value: '- /**',
        hasMacro: false,
      });
      expect(parsed.flags[1]).toEqual({
        raw: '--max-delete -10',
        key: 'max-delete',
        value: '-10',
        hasMacro: false,
      });
    });

    it('should not consume the next token when it is a valid flag', () => {
      const parsed = service.parse('rclone sync src: dst: --verbose --dry-run', new Set());
      expect(parsed.flags.length).toBe(2);
      expect(parsed.flags[0]).toEqual({
        raw: '--verbose',
        key: 'verbose',
        value: true,
        hasMacro: false,
      });
      expect(parsed.flags[1]).toEqual({
        raw: '--dry-run',
        key: 'dry-run',
        value: true,
        hasMacro: false,
      });
    });
  });
});
