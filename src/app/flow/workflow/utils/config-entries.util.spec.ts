import { describe, it, expect } from 'vitest';
import { extractActiveConfigEntries, PRIMARY_EXCLUDED_KEYS } from './config-entries.util';

describe('config-entries.util', () => {
  it('should return empty array for null, undefined or empty config', () => {
    expect(extractActiveConfigEntries(null)).toEqual([]);
    expect(extractActiveConfigEntries(undefined)).toEqual([]);
    expect(extractActiveConfigEntries({})).toEqual([]);
  });

  it('should extract shared sections (vfs, filter, backend, runtimeRemote)', () => {
    const config = {
      config: {
        rclone: {
          vfs: {
            cacheMode: 'full',
            vfsReadChunkSize: '128M',
          },
          filter: {
            include: ['*.pdf'],
          },
          backend: {
            chunkSize: '64M',
          },
          runtimeRemote: {
            customParam: 'testValue',
          },
        },
      },
    };

    const entries = extractActiveConfigEntries(config);
    expect(entries).toEqual(
      expect.arrayContaining([
        {
          category: 'vfs',
          key: 'cacheMode',
          value: 'full',
          path: 'config.rclone.vfs.cacheMode',
        },
        {
          category: 'vfs',
          key: 'vfsReadChunkSize',
          value: '128M',
          path: 'config.rclone.vfs.vfsReadChunkSize',
        },
        {
          category: 'filter',
          key: 'include',
          value: '*.pdf',
          path: 'config.rclone.filter.include',
        },
        {
          category: 'backend',
          key: 'chunkSize',
          value: '64M',
          path: 'config.rclone.backend.chunkSize',
        },
        {
          category: 'general',
          key: 'customParam',
          value: 'testValue',
          path: 'config.rclone.runtimeRemote.customParam',
        },
      ])
    );
  });

  it('should extract direct operation options and ignore excluded keys', () => {
    const config = {
      config: {
        rclone: {
          srcFs: '/local/src', // in PRIMARY_EXCLUDED_KEYS
          dstFs: 'remote:dst', // in PRIMARY_EXCLUDED_KEYS
          transfers: 8,
          checkers: 16,
          dryRun: true,
        },
      },
    };

    const entries = extractActiveConfigEntries(config);
    expect(entries).toHaveLength(3);
    expect(entries).toContainEqual({
      category: 'operation',
      key: 'transfers',
      value: '8',
      path: 'config.rclone.transfers',
    });
    expect(entries).toContainEqual({
      category: 'operation',
      key: 'checkers',
      value: '16',
      path: 'config.rclone.checkers',
    });
    expect(entries).toContainEqual({
      category: 'operation',
      key: 'dryRun',
      value: 'true',
      path: 'config.rclone.dryRun',
    });
  });

  it('should handle custom configuration properties and ignore primary excluded keys', () => {
    const config = {
      customKey: 'value1',
      command: 'mysqldump', // in PRIMARY_EXCLUDED_KEYS
      timeoutSeconds: 30, // in PRIMARY_EXCLUDED_KEYS
      extraFlag: false,
    };

    const entries = extractActiveConfigEntries(config);
    expect(entries).toHaveLength(2);
    expect(entries).toContainEqual({
      category: 'operation',
      key: 'customKey',
      value: 'value1',
      path: 'config.rclone.customKey',
    });
    expect(entries).toContainEqual({
      category: 'operation',
      key: 'extraFlag',
      value: 'false',
      path: 'config.rclone.extraFlag',
    });
  });

  it('should ignore empty, null, or undefined values', () => {
    const config = {
      config: {
        rclone: {
          validOpt: 'yes',
          emptyStr: '',
          nullVal: null,
          undefVal: undefined,
        },
      },
    };

    const entries = extractActiveConfigEntries(config);
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe('validOpt');
  });

  it('should verify PRIMARY_EXCLUDED_KEYS set contains standard primary keys', () => {
    expect(PRIMARY_EXCLUDED_KEYS.has('remote')).toBe(true);
    expect(PRIMARY_EXCLUDED_KEYS.has('cronExpression')).toBe(true);
    expect(PRIMARY_EXCLUDED_KEYS.has('mountPoint')).toBe(true);
  });
});
