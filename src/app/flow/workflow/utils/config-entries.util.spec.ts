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
          tone: 'yellow',
          key: 'cacheMode',
          value: 'full',
          path: 'config.rclone.vfs.cacheMode',
        },
        {
          category: 'vfs',
          tone: 'yellow',
          key: 'vfsReadChunkSize',
          value: '128M',
          path: 'config.rclone.vfs.vfsReadChunkSize',
        },
        {
          category: 'filter',
          tone: 'primary',
          key: 'include',
          value: '*.pdf',
          path: 'config.rclone.filter.include',
        },
        {
          category: 'backend',
          tone: 'orange',
          key: 'chunkSize',
          value: '64M',
          path: 'config.rclone.backend.chunkSize',
        },
        {
          category: 'runtimeRemote',
          tone: 'purple',
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
      tone: 'accent',
      key: 'transfers',
      value: '8',
      path: 'config.rclone.transfers',
    });
    expect(entries).toContainEqual({
      category: 'operation',
      tone: 'accent',
      key: 'checkers',
      value: '16',
      path: 'config.rclone.checkers',
    });
    expect(entries).toContainEqual({
      category: 'operation',
      tone: 'accent',
      key: 'dryRun',
      value: 'true',
      path: 'config.rclone.dryRun',
    });
  });

  it('shows the runtime remote settings the editor saves under remotes, one by one, each with its remote', () => {
    const entries = extractActiveConfigEntries({
      config: {
        rclone: {
          remotes: {
            gdrive: { chunk_size: '128M', acknowledge_abuse: true, unset: '' },
            s3: { region: 'eu-west-1' },
          },
        },
      },
    });

    expect(entries.map(e => [e.scope, e.key, e.value, e.path])).toEqual([
      ['gdrive', 'chunk_size', '128M', 'config.rclone.remotes.gdrive.chunk_size'],
      ['gdrive', 'acknowledge_abuse', 'true', 'config.rclone.remotes.gdrive.acknowledge_abuse'],
      ['s3', 'region', 'eu-west-1', 'config.rclone.remotes.s3.region'],
    ]);
    expect(entries.every(e => e.category === 'runtimeRemote' && e.tone === 'purple')).toBe(true);
  });

  it('also reads runtime remote settings kept per remote under the older runtimeRemote key', () => {
    const entries = extractActiveConfigEntries({
      config: {
        rclone: {
          runtimeRemote: {
            gdrive: { chunk_size: '128M', acknowledge_abuse: true, unset: '' },
            s3: { region: 'eu-west-1' },
          },
        },
      },
    });

    expect(entries).toEqual([
      {
        category: 'runtimeRemote',
        tone: 'purple',
        scope: 'gdrive',
        key: 'chunk_size',
        value: '128M',
        path: 'config.rclone.runtimeRemote.gdrive.chunk_size',
      },
      {
        category: 'runtimeRemote',
        tone: 'purple',
        scope: 'gdrive',
        key: 'acknowledge_abuse',
        value: 'true',
        path: 'config.rclone.runtimeRemote.gdrive.acknowledge_abuse',
      },
      {
        category: 'runtimeRemote',
        tone: 'purple',
        scope: 's3',
        key: 'region',
        value: 'eu-west-1',
        path: 'config.rclone.runtimeRemote.s3.region',
      },
    ]);
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
      tone: 'accent',
      key: 'customKey',
      value: 'value1',
      path: 'config.rclone.customKey',
    });
    expect(entries).toContainEqual({
      category: 'operation',
      tone: 'accent',
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

  it('keeps path inputs out of the flag summary while preserving zero and false values', () => {
    const paths = Object.fromEntries(
      ['srcFs', 'dstFs', 'path1', 'path2', 'mountPoint', 'dest', 'fs', 'source', 'path'].map(
        key => [key, 'drive:Arşiv & 旅行']
      )
    );
    expect(
      extractActiveConfigEntries({ config: { rclone: { ...paths, transfers: 0, dryRun: false } } })
    ).toEqual([
      {
        category: 'operation',
        tone: 'accent',
        key: 'transfers',
        value: '0',
        path: 'config.rclone.transfers',
      },
      {
        category: 'operation',
        tone: 'accent',
        key: 'dryRun',
        value: 'false',
        path: 'config.rclone.dryRun',
      },
    ]);
  });

  it('should verify PRIMARY_EXCLUDED_KEYS set contains standard primary keys', () => {
    expect(PRIMARY_EXCLUDED_KEYS.has('remote')).toBe(true);
    expect(PRIMARY_EXCLUDED_KEYS.has('cronExpression')).toBe(true);
    expect(PRIMARY_EXCLUDED_KEYS.has('mountPoint')).toBe(true);
  });
});
