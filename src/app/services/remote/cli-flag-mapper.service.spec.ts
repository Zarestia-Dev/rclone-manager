import * as cliParser from 'src/app/shared/utils/cli-parser.util';
import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { CliFlagMapperService } from './cli-flag-mapper.service';
import { FlagConfigService } from './flag-config.service';
import { RemoteManagementService } from './remote-management.service';
import { RcloneValueMapperService } from './rclone-value-mapper.service';
import { RcConfigOption, SharedProfileType } from '@app/types';
import type { ParsedCLI } from 'src/app/shared/utils/cli-parser.util';
import { beforeEach, describe, expect, it } from 'vitest';

// The spec exercises flag classification and lookup-table construction. None of them touch the network, so we stub out the two
// dependencies that would otherwise pull in HttpClient + TranslateService +
// MatSnackBar + MatDialog.
function stubFlagConfig(): Partial<FlagConfigService> {
  return {
    loadAllFlagFields: () => Promise.resolve({} as Record<string, RcConfigOption[]>),
  };
}

function stubRemoteManagement(): Partial<RemoteManagementService> {
  return {
    getRemoteConfigFields: () => Promise.resolve([]),
  };
}

// `buildLookupTable` expects a Record over all SharedProfileType keys, but the
// tests only need to supply the ones they exercise. Treat partial input as
// full records — the missing keys just yield no entries.
function fields(
  input: Partial<Record<SharedProfileType, RcConfigOption[]>>
): Record<SharedProfileType, RcConfigOption[]> {
  return input as Record<SharedProfileType, RcConfigOption[]>;
}

describe('CliFlagMapperService', () => {
  let service: CliFlagMapperService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        CliFlagMapperService,
        RcloneValueMapperService,
        provideTranslateService(),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: FlagConfigService, useValue: stubFlagConfig() },
        { provide: RemoteManagementService, useValue: stubRemoteManagement() },
      ],
    });
    service = TestBed.inject(CliFlagMapperService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('classify', () => {
    it.each<{ type: string; value: string | boolean; expected: unknown }>([
      { type: 'bool', value: true, expected: true },
      { type: 'bool', value: false, expected: false },
      { type: 'bool', value: ' TRUE ', expected: true },
      { type: 'bool', value: ' FALSE ', expected: false },
      { type: 'bool', value: '', expected: '' },
      { type: 'bool', value: 'invalid', expected: 'invalid' },
      { type: 'Tristate', value: true, expected: true },
      { type: 'Tristate', value: false, expected: false },
      { type: 'Tristate', value: ' TRUE ', expected: true },
      { type: 'Tristate', value: ' FALSE ', expected: false },
      { type: 'Tristate', value: '', expected: null },
      { type: 'Tristate', value: 'unset', expected: null },
      { type: 'Tristate', value: 'null', expected: null },
      { type: 'Tristate', value: 'invalid', expected: null },
      { type: 'int', value: '-10', expected: -10 },
      { type: 'uint64', value: '0', expected: 0 },
      { type: 'float64', value: '2.5', expected: 2.5 },
      { type: 'FileMode', value: '0755', expected: 0o755 },
      { type: 'CommaSepList', value: ' png, jpg , ', expected: ['png', 'jpg'] },
      { type: 'SpaceSepList', value: ' png\t jpg ', expected: ['png', 'jpg'] },
      { type: 'string', value: '旅行 & Arşiv', expected: '旅行 & Arşiv' },
      { type: 'string', value: 'false', expected: 'false' },
      { type: 'int', value: true, expected: true },
      { type: 'string', value: false, expected: false },
    ])('converts $type flag value $value to $expected', ({ type, value, expected }) => {
      const lookupTable = service.buildLookupTable(
        fields({
          sync: [{ Name: 'example', FieldName: 'Example', Type: type, Help: '', DefaultStr: '' }],
        })
      );
      const parsed: ParsedCLI = {
        verb: 'sync',
        flags: [{ raw: '--example', key: 'example', value, hasMacro: false }],
      };
      const result = service.classify(parsed, lookupTable);
      expect(result.classified[0]).toMatchObject({
        status: 'mapped',
        flagType: 'sync',
        fieldName: 'example',
        coercedValue: expected,
      });
      expect(parsed.flags[0].value).toBe(value);
    });

    it.each(['bool', 'Tristate'])(
      'keeps direct no-flag matches ahead of negation for %s fields',
      type => {
        const lookupTable = service.buildLookupTable(
          fields({
            sync: [
              { Name: 'traverse', FieldName: 'Traverse', Type: type, Help: '', DefaultStr: '' },
              { Name: 'check', FieldName: 'Check', Type: type, Help: '', DefaultStr: '' },
              { Name: 'no_check', FieldName: 'NoCheck', Type: type, Help: '', DefaultStr: '' },
            ],
          })
        );
        const parsed = cliParser.parseCLI(
          'rclone sync src: dst: --no-traverse --no-check',
          new Set(['no-traverse', 'no-check'])
        );
        const result = service.classify(parsed, lookupTable);
        expect(result.classified[0]).toMatchObject({
          status: 'mapped',
          fieldName: 'traverse',
          coercedValue: false,
        });
        expect(result.classified[1]).toMatchObject({
          status: 'mapped',
          fieldName: 'no_check',
          coercedValue: true,
        });
      }
    );

    // Note: rclone RC API uses underscores in Name (e.g. "max_delete"), CLI uses hyphens (--max-delete)
    it('should match --max-delete (hyphen) against max_delete (underscore) from RC API', () => {
      const lookupTable = service.buildLookupTable(
        fields({
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
        })
      );
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
      expect(result.classified[0].fieldName).toBe('max_delete');
      expect(result.classified[0].coercedValue).toBe(50);

      expect(result.classified[1].status).toBe('mapped');
      expect(result.classified[1].fieldName).toBe('track_renames');

      expect(result.classified[2].status).toBe('unknown');
    });

    it('should coerce uint and float types', () => {
      const lookupTable = service.buildLookupTable(
        fields({
          sync: [
            { Name: 'tpslimit', FieldName: 'TpsLimit', Type: 'float64', Help: '', DefaultStr: '' },
            {
              Name: 'tpslimit-burst',
              FieldName: 'TpsLimitBurst',
              Type: 'uint32',
              Help: '',
              DefaultStr: '',
            },
          ],
        })
      );

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
      const lookupTable = service.buildLookupTable(
        fields({
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
        }),
        's3'
      );
      const parsed: ParsedCLI = {
        verb: 'serve',
        flags: [
          { raw: '--s3-provider AWS', key: 's3-provider', value: 'AWS', hasMacro: false },
          { raw: '--s3-chunk-size 64M', key: 's3-chunk-size', value: '64M', hasMacro: false },
        ],
      };

      const result = service.classify(parsed, lookupTable);
      expect(result.classified[0].status).toBe('mapped');
      expect(result.classified[0].fieldName).toBe('provider');
      expect(result.classified[0].coercedValue).toBe('AWS');

      expect(result.classified[1].status).toBe('mapped');
      expect(result.classified[1].fieldName).toBe('chunk_size');
      expect(result.classified[1].coercedValue).toBe('64M');
    });

    it('should strip bash-style comments', () => {
      // Line continuation (\) + newline joins the lines, then # starts a comment
      // that runs to the end of the line.
      const tokens = cliParser.tokenize(
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
      const parsed = cliParser.parseCLI(
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
      const parsed = cliParser.parseCLI('rclone sync src: dst: --verbose --dry-run', new Set());
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

    it('should parse check, delete, copyurl and other rclone verbs correctly', () => {
      const parsedCheck = cliParser.parseCLI('rclone check remote:path /local/path', new Set());
      expect(parsedCheck.verb).toBe('check');
      expect(parsedCheck.sourcePath).toBe('remote:path');
      expect(parsedCheck.destPath).toBe('/local/path');

      const parsedDelete = cliParser.parseCLI('rclone delete remote:path/folder', new Set());
      expect(parsedDelete.verb).toBe('delete');
      expect(parsedDelete.sourcePath).toBe('remote:path/folder');

      const parsedCopyurl = cliParser.parseCLI(
        'rclone copyurl https://example.com/file.zip remote:path',
        new Set()
      );
      expect(parsedCopyurl.verb).toBe('copyurl');
      expect(parsedCopyurl.sourcePath).toBe('https://example.com/file.zip');
      expect(parsedCopyurl.destPath).toBe('remote:path');

      const parsedPurge = cliParser.parseCLI('rclone purge remote:path/trash', new Set());
      expect(parsedPurge.verb).toBe('delete');
      expect(parsedPurge.sourcePath).toBe('remote:path/trash');
    });

    it('should strip wrapper commands and binary paths like sudo, /usr/bin/rclone, wsl', () => {
      const parsedSudo = cliParser.parseCLI('sudo /usr/bin/rclone sync src: dst:', new Set());
      expect(parsedSudo.verb).toBe('sync');
      expect(parsedSudo.sourcePath).toBe('src:');
      expect(parsedSudo.destPath).toBe('dst:');

      const parsedWsl = cliParser.parseCLI('wsl rclone copy src: dst:', new Set());
      expect(parsedWsl.verb).toBe('copy');
      expect(parsedWsl.sourcePath).toBe('src:');
      expect(parsedWsl.destPath).toBe('dst:');
    });

    it('should map short flag aliases such as -P, -v, -n, -u, -L, -c, -I', () => {
      const lookupTable = service.buildLookupTable(
        fields({
          sync: [
            { Name: 'progress', FieldName: 'Progress', Type: 'bool', Help: '', DefaultStr: '' },
            { Name: 'verbose', FieldName: 'Verbose', Type: 'int', Help: '', DefaultStr: '' },
            { Name: 'dry_run', FieldName: 'DryRun', Type: 'bool', Help: '', DefaultStr: '' },
            { Name: 'update', FieldName: 'Update', Type: 'bool', Help: '', DefaultStr: '' },
            { Name: 'copy_links', FieldName: 'CopyLinks', Type: 'bool', Help: '', DefaultStr: '' },
            { Name: 'checksum', FieldName: 'Checksum', Type: 'bool', Help: '', DefaultStr: '' },
            {
              Name: 'ignore_times',
              FieldName: 'IgnoreTimes',
              Type: 'bool',
              Help: '',
              DefaultStr: '',
            },
          ],
        })
      );

      const parsed = cliParser.parseCLI('rclone sync src: dst: -P -v -n -u -L -c -I', new Set());
      const result = service.classify(parsed, lookupTable);

      expect(result.classified.length).toBe(7);
      expect(result.classified.every(f => f.status === 'mapped')).toBe(true);
      expect(result.classified[0].fieldName).toBe('progress');
      expect(result.classified[1].fieldName).toBe('verbose');
      expect(result.classified[2].fieldName).toBe('dry_run');
      expect(result.classified[3].fieldName).toBe('update');
      expect(result.classified[4].fieldName).toBe('copy_links');
      expect(result.classified[5].fieldName).toBe('checksum');
      expect(result.classified[6].fieldName).toBe('ignore_times');
    });

    it('should support negated flags (--no-traverse -> traverse = false)', () => {
      const lookupTable = service.buildLookupTable(
        fields({
          sync: [
            { Name: 'traverse', FieldName: 'Traverse', Type: 'bool', Help: '', DefaultStr: '' },
            {
              Name: 'check_certificate',
              FieldName: 'CheckCertificate',
              Type: 'bool',
              Help: '',
              DefaultStr: '',
            },
          ],
        })
      );

      const parsed = cliParser.parseCLI(
        'rclone sync src: dst: --no-traverse --no-check-certificate',
        new Set()
      );
      const result = service.classify(parsed, lookupTable);

      expect(result.classified.length).toBe(2);
      expect(result.classified[0].status).toBe('mapped');
      expect(result.classified[0].fieldName).toBe('traverse');
      expect(result.classified[0].coercedValue).toBe(false);

      expect(result.classified[1].status).toBe('mapped');
      expect(result.classified[1].fieldName).toBe('check_certificate');
      expect(result.classified[1].coercedValue).toBe(false);
    });

    it('should parse explicit boolean values like --fast-list=false and --dry-run=true', () => {
      const lookupTable = service.buildLookupTable(
        fields({
          backend: [
            { Name: 'fast_list', FieldName: 'FastList', Type: 'bool', Help: '', DefaultStr: '' },
          ],
          sync: [{ Name: 'dry_run', FieldName: 'DryRun', Type: 'bool', Help: '', DefaultStr: '' }],
        })
      );

      const parsed = cliParser.parseCLI(
        'rclone sync src: dst: --fast-list=false --dry-run=true',
        new Set()
      );
      const result = service.classify(parsed, lookupTable);

      expect(result.classified[0].status).toBe('mapped');
      expect(result.classified[0].coercedValue).toBe(false);

      expect(result.classified[1].status).toBe('mapped');
      expect(result.classified[1].coercedValue).toBe(true);
    });

    it('should parse non-bool flag followed by hyphenated value such as --suffix -bak', () => {
      const lookupTable = service.buildLookupTable(
        fields({
          sync: [{ Name: 'suffix', FieldName: 'Suffix', Type: 'string', Help: '', DefaultStr: '' }],
        })
      );

      const parsed = cliParser.parseCLI('rclone sync src: dst: --suffix -bak', new Set());
      expect(parsed.flags.length).toBe(1);
      expect(parsed.flags[0].key).toBe('suffix');
      expect(parsed.flags[0].value).toBe('-bak');

      const result = service.classify(parsed, lookupTable);
      expect(result.classified[0].status).toBe('mapped');
      expect(result.classified[0].fieldName).toBe('suffix');
      expect(result.classified[0].coercedValue).toBe('-bak');
    });

    it('should resolve shared Copy group flags to the active or detected verb (e.g. sync)', () => {
      // Both copy and sync define checksum and backup_dir
      const lookupTable = service.buildLookupTable(
        fields({
          sync: [
            { Name: 'checksum', FieldName: 'Checksum', Type: 'bool', Help: '', DefaultStr: '' },
            {
              Name: 'backup_dir',
              FieldName: 'BackupDir',
              Type: 'string',
              Help: '',
              DefaultStr: '',
            },
          ],
          copy: [
            { Name: 'checksum', FieldName: 'Checksum', Type: 'bool', Help: '', DefaultStr: '' },
            {
              Name: 'backup_dir',
              FieldName: 'BackupDir',
              Type: 'string',
              Help: '',
              DefaultStr: '',
            },
          ],
          move: [
            { Name: 'checksum', FieldName: 'Checksum', Type: 'bool', Help: '', DefaultStr: '' },
            {
              Name: 'backup_dir',
              FieldName: 'BackupDir',
              Type: 'string',
              Help: '',
              DefaultStr: '',
            },
          ],
        })
      );

      const parsed = cliParser.parseCLI(
        'rclone sync src: dst: --checksum --backup-dir dst:_backup',
        new Set(['checksum'])
      );
      const result = service.classify(parsed, lookupTable);

      expect(result.classified[0].status).toBe('mapped');
      expect(result.classified[0].flagType).toBe('sync');
      expect(result.classified[0].fieldName).toBe('checksum');

      expect(result.classified[1].status).toBe('mapped');
      expect(result.classified[1].flagType).toBe('sync');
      expect(result.classified[1].fieldName).toBe('backup_dir');
    });
  });
});
