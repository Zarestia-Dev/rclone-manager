import { describe, expect, it } from 'vitest';
import { ImportResult, ClassifiedFlag } from '../cli-flag-mapper.service';
import { SharedProfileType } from '@app/types';
import { mergeImportedFlags, mergeImportedProfile } from './profile-import.utils';

function flag(type: SharedProfileType, field: string, value: unknown): ClassifiedFlag {
  return {
    flag: { key: field, raw: `--${field}`, value: true, hasMacro: false },
    status: 'mapped',
    flagType: type,
    fieldName: field,
    coercedValue: value,
  };
}

describe('profile import', () => {
  const result: ImportResult = {
    sourcePath: 'drive:my photos',
    destPath: '/backup folder',
    classified: [flag('sync', 'dry_run', false), flag('filter', 'include', ['*.jpg'])],
  };

  it('merges operation paths and flags without overwriting app settings or linked options', () => {
    const existing = {
      app: { autoStart: true, filterProfile: 'Photos' },
      rclone: { transfers: 2 },
    };
    expect(mergeImportedProfile('sync', existing, result, true, true, 'drive')).toEqual({
      app: existing.app,
      rclone: { transfers: 2, srcFs: ['drive:my photos'], dstFs: '/backup folder', dry_run: false },
    });
    expect(existing).toEqual({
      app: { autoStart: true, filterProfile: 'Photos' },
      rclone: { transfers: 2 },
    });
  });

  it('respects source and destination import choices', () => {
    expect(mergeImportedProfile('sync', {}, result, false, false, 'drive')).toEqual({
      app: {},
      rclone: { dry_run: false },
    });
    expect(
      mergeImportedProfile('delete', {}, { ...result, classified: [] }, true, true, 'drive')
    ).toEqual({
      app: {},
      rclone: { srcFs: ['drive:my photos'] },
    });
  });

  it('ignores unknown flags, flags without a mapped field, and flags for other sections', () => {
    const imported: ImportResult = {
      classified: [
        ...result.classified,
        { ...flag('filter', 'unknown', true), status: 'unknown' },
        { ...flag('filter', 'missing', true), fieldName: undefined },
      ],
    };
    expect(mergeImportedFlags({ exclude: ['*.tmp'] }, imported, 'filter')).toEqual({
      exclude: ['*.tmp'],
      include: ['*.jpg'],
    });
    expect(mergeImportedFlags({}, { classified: [] }, 'filter')).toEqual({});
  });

  it('preserves runtime options scoped to other remotes', () => {
    const imported: ImportResult = { classified: [flag('runtimeRemote', 'region', "a'b,c")] };
    expect(
      mergeImportedProfile(
        'runtimeRemote',
        {
          drive: { env_auth: true },
          other: { region: 'old' },
        },
        imported,
        false,
        false,
        'drive'
      )
    ).toEqual({
      drive: { env_auth: true, region: "a'b,c" },
      other: { region: 'old' },
    });
  });

  it('imports a runtime profile without nesting another remote under the current one', () => {
    const existing = { other: { region: 'eu' } };
    const imported: ImportResult = { classified: [flag('runtimeRemote', 'env_auth', false)] };
    expect(
      mergeImportedProfile('runtimeRemote', existing, imported, false, false, 'drive')
    ).toEqual({ other: { region: 'eu' }, drive: { env_auth: false } });
    expect(existing).toEqual({ other: { region: 'eu' } });
    expect(
      mergeImportedProfile('runtimeRemote', { region: 'us' }, imported, false, false, 'drive')
    ).toEqual({ drive: { region: 'us', env_auth: false } });
  });

  it.each([
    [
      'mount',
      { mountSubtype: 'mount2' },
      { fs: 'drive:my photos', mountPoint: '/backup folder', mountType: 'mount2' },
    ],
    ['serve', { serveSubtype: 'webdav' }, { fs: 'drive:my photos', type: 'webdav' }],
  ] as const)('preserves the imported %s subtype', (type, subtype, expected) => {
    const imported: ImportResult = { ...result, ...subtype, classified: [] };
    expect(mergeImportedProfile(type, {}, imported, true, true, 'drive')).toEqual({
      app: {},
      rclone: expected,
    });
  });
});
