import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { provideTranslateService } from '@ngx-translate/core';
import { PathStyle } from '@app/types';
import * as pathUtils from '../../../shared/utils/path.utils';

import {
  inspectAfterPause,
  PATH_INSPECTION_UNAVAILABLE,
  PathInspectionService,
} from './path-inspection.service';
import { ApiClientService } from './api-client.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { RemoteFacadeService } from '../../facade/remote-facade.service';
import {
  NAMES_ONLY,
  RemoteFileOperationsService,
} from '../../remote/remote-file-operations.service';
import { PathService } from './path.service';
import { NotificationService } from '../../ui/notification.service';
import { BackendTranslationService } from '../../i18n/backend-translation.service';
import { MountManagementService } from '../../operations/mount-management.service';
import { QuickRunService } from '../../flow/quick-run.service';

describe('PathInspectionService', () => {
  let service: PathInspectionService;
  let mockApiClient: { invoke: ReturnType<typeof vi.fn> };
  let mountedRemotes: WritableSignal<unknown[]>;
  let quickRuns: WritableSignal<unknown[]>;
  let mockAppSettings: { getSettingValue: ReturnType<typeof vi.fn> };
  let remoteSettings: ReturnType<typeof vi.fn>;
  let mockRemoteFileOps: {
    getStat: ReturnType<typeof vi.fn>;
    getSize: ReturnType<typeof vi.fn>;
    getRemotePaths: ReturnType<typeof vi.fn>;
    makeDirectory: ReturnType<typeof vi.fn>;
  };
  let mockPathService: {
    splitLocalForStat: ReturnType<typeof vi.fn>;
    enginePathStyle: ReturnType<typeof vi.fn>;
    normalizeForPlatform: ReturnType<typeof vi.fn>;
    getParentPath: ReturnType<typeof vi.fn>;
    isTrulyLocalPath: ReturnType<typeof vi.fn>;
    splitFsPath: ReturnType<typeof vi.fn>;
    normalizeRemoteForRclone: ReturnType<typeof vi.fn>;
    checkMountPathCollision: ReturnType<typeof vi.fn>;
    getRemoteNameFromFs: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockApiClient = { invoke: vi.fn() };
    mountedRemotes = signal<unknown[]>([]);
    quickRuns = signal<unknown[]>([]);
    mockAppSettings = { getSettingValue: vi.fn().mockResolvedValue(null) };
    remoteSettings = vi.fn().mockReturnValue({});
    mockRemoteFileOps = {
      getStat: vi.fn().mockResolvedValue({ item: null }),
      getSize: vi.fn().mockResolvedValue({ count: 0 }),
      getRemotePaths: vi.fn().mockResolvedValue({ list: [] }),
      makeDirectory: vi.fn().mockResolvedValue(undefined),
    };
    mockPathService = {
      splitLocalForStat: vi.fn().mockReturnValue({ root: '/', relative: 'home/user/path' }),
      enginePathStyle: vi.fn().mockReturnValue('posix'),
      normalizeForPlatform: vi.fn().mockImplementation((p: string) => p),
      getParentPath: vi.fn().mockReturnValue('/home/user'),
      isTrulyLocalPath: vi.fn().mockReturnValue(true),
      splitFsPath: vi.fn(),
      normalizeRemoteForRclone: vi.fn((remote: string) => `${remote}:`),
      checkMountPathCollision: vi.fn().mockReturnValue([]),
      getRemoteNameFromFs: vi.fn((fs: string) => fs.split(':')[0]),
    };

    TestBed.configureTestingModule({
      providers: [
        PathInspectionService,
        provideTranslateService(),
        { provide: NotificationService, useValue: {} },
        { provide: BackendTranslationService, useValue: {} },
        { provide: ApiClientService, useValue: mockApiClient },
        { provide: AppSettingsService, useValue: mockAppSettings },
        { provide: RemoteFacadeService, useValue: { remoteSettings } },
        { provide: RemoteFileOperationsService, useValue: mockRemoteFileOps },
        { provide: PathService, useValue: mockPathService },
        { provide: MountManagementService, useValue: { mountedRemotes } },
        { provide: QuickRunService, useValue: { quickRuns } },
      ],
    });

    service = TestBed.inject(PathInspectionService);
  });

  describe('inspect', () => {
    it.each(['X:', 'X:\\', 'X:/', '\\\\server\\example'])(
      'does not browse the contents of the Windows mount target %s',
      async path => {
        mockPathService.enginePathStyle.mockReturnValue('windows');
        expect(await service.inspect(path, 'example', 'Default', 'mount')).toBeNull();
        expect(mockPathService.checkMountPathCollision).toHaveBeenCalled();
        expect(mockRemoteFileOps.getStat).not.toHaveBeenCalled();
        expect(mockRemoteFileOps.getRemotePaths).not.toHaveBeenCalled();
      }
    );

    it('does not attempt to reserve a fixed path for an automatic Windows drive', async () => {
      mockPathService.enginePathStyle.mockReturnValue('windows');
      expect(await service.inspect('*', 'example', 'Default', 'mount')).toBeNull();
      expect(remoteSettings).not.toHaveBeenCalled();
      expect(mockRemoteFileOps.getStat).not.toHaveBeenCalled();
    });

    it('reports an existing Windows mount directory without reading its contents', async () => {
      mockPathService.enginePathStyle.mockReturnValue('windows');
      mockRemoteFileOps.getStat.mockResolvedValue({ item: { IsDir: true } });
      expect(await service.inspect('D:\\Cloud', 'example', 'Default', 'mount')).toMatchObject({
        state: 'exists',
        labelKey: 'wizards.appOperation.mountFolderAlreadyExists',
      });
      expect(mockRemoteFileOps.getRemotePaths).not.toHaveBeenCalled();
    });

    it('does not inspect the WinFsp folder already mounted by this Windows profile', async () => {
      mockPathService.enginePathStyle.mockReturnValue('windows');
      mockRemoteFileOps.getStat.mockResolvedValue({ item: { IsDir: false } });
      mountedRemotes.set([
        {
          fs: 'example:share',
          mount_point: 'D:/test/Example/',
          starter: { kind: 'profile', name: 'Default' },
        },
      ]);
      expect(await service.inspect('d:\\test\\example', 'example', 'Default', 'mount')).toBeNull();
      expect(mockRemoteFileOps.getStat).not.toHaveBeenCalled();
    });

    it.each([
      ['D:\\test\\other.txt', 'example', 'Default'],
      ['D:\\test\\example', 'another', 'Default'],
      ['D:\\test\\example', 'example', 'Another'],
    ])(
      'checks %s when the path or profile differs from the active mount',
      async (path, remote, profile) => {
        mockPathService.enginePathStyle.mockReturnValue('windows');
        mockRemoteFileOps.getStat.mockResolvedValue({ item: { IsDir: false } });
        mountedRemotes.set([
          {
            fs: 'example:',
            mount_point: 'D:\\test\\example',
            starter: { kind: 'profile', name: 'Default' },
          },
        ]);
        expect(await service.inspect(path, remote, profile, 'mount')).toMatchObject({
          state: 'notDirectory',
        });
      }
    );

    it('forwards the edited profile and operation so it can exclude itself from collisions', async () => {
      await service.inspect('/mnt/drive', 'drive', 'Shared', 'mount');
      expect(mockPathService.checkMountPathCollision).toHaveBeenCalledWith(
        '/mnt/drive',
        'drive',
        {},
        'Shared',
        'mount',
        { runs: [], exceptId: undefined }
      );
    });
    it('hands the Quick Runs to the collision check, and the one being edited as the exception', async () => {
      const run = {
        id: 'qr-1',
        name: 'Drive',
        operationType: 'mount',
        remoteName: 'drive',
        config: { app: {}, rclone: { mountPoint: '/mnt/drive' } },
      };
      quickRuns.set([run]);

      await service.inspect('/mnt/drive', 'drive');
      expect(mockPathService.checkMountPathCollision).toHaveBeenLastCalledWith(
        '/mnt/drive',
        'drive',
        {},
        undefined,
        undefined,
        { runs: [run], exceptId: undefined }
      );

      await service.inspect('/mnt/drive', 'drive', undefined, 'mount', 'qr-1');
      expect(mockPathService.checkMountPathCollision).toHaveBeenLastCalledWith(
        '/mnt/drive',
        'drive',
        {},
        undefined,
        'mount',
        { runs: [run], exceptId: 'qr-1' }
      );
    });

    it.each([
      ['profile', 'remoteConfig.pathStatus.collidingProfile'],
      ['quick_run', 'remoteConfig.pathStatus.collidingQuickRun'],
    ])('names the %s that uses the folder', async (kind, labelKey) => {
      mockPathService.checkMountPathCollision.mockReturnValue([
        { kind, name: 'Photos', remoteName: 'otherRemote', opType: 'mount', path: '/x' },
      ]);

      const status = await service.inspect('/home/user/colliding', 'remote1');

      expect(status).toEqual({
        state: 'colliding',
        icon: 'warning',
        badgeClass: 'colliding',
        labelKey,
        labelParams: { name: 'Photos', remote: 'otherRemote' },
      });
      expect(mockRemoteFileOps.getStat).not.toHaveBeenCalled();
    });

    it('should resolve to willCreate if file does not exist on disk', async () => {
      mockRemoteFileOps.getStat.mockResolvedValue({ item: null });

      const status = await service.inspect('/home/user/new-dir', 'remote1');

      expect(status).toEqual({
        state: 'willCreate',
        icon: 'folder-plus',
        badgeClass: 'will-create',
        labelKey: 'remoteConfig.pathStatus.willCreate',
      });
      expect(mockRemoteFileOps.getSize).not.toHaveBeenCalled();
      expect(mockRemoteFileOps.getRemotePaths).not.toHaveBeenCalled();
    });

    it('should resolve to clean if directory exists and has 0 items', async () => {
      mockRemoteFileOps.getStat.mockResolvedValue({ item: { Path: 'clean-path', IsDir: true } });

      const status = await service.inspect('/home/user/clean-path', 'remote1');

      expect(status).toEqual({
        state: 'clean',
        icon: 'check-circle',
        badgeClass: 'clean',
        labelKey: 'remoteConfig.pathStatus.clean',
      });
      expect(mockRemoteFileOps.getRemotePaths).toHaveBeenCalledExactlyOnceWith(
        '/',
        'home/user/path',
        { ...NAMES_ONLY, recurse: false }
      );
      expect(mockRemoteFileOps.getSize).not.toHaveBeenCalled();
    });

    it.each([
      [false, 'notDirectory', 'remoteConfig.pathStatus.notDirectory'],
      [undefined, 'unavailable', 'remoteConfig.pathStatus.unavailable'],
    ])('reports the right warning for IsDir = %s', async (isDir, state, labelKey) => {
      mockRemoteFileOps.getStat.mockResolvedValue({ item: { Path: 'file.txt', IsDir: isDir } });
      expect(await service.inspect('/home/user/file.txt', 'drive')).toMatchObject({
        state,
        labelKey,
      });
      expect(mockRemoteFileOps.getSize).not.toHaveBeenCalled();
      expect(mockRemoteFileOps.getRemotePaths).not.toHaveBeenCalled();
    });

    it('lists the valid Windows mount targets when the path points to a file', async () => {
      mockPathService.enginePathStyle.mockReturnValue('windows');
      mockRemoteFileOps.getStat.mockResolvedValue({ item: { IsDir: false } });
      expect(await service.inspect('D:\\file.txt', 'example', 'Default', 'mount')).toMatchObject({
        state: 'notDirectory',
        labelKey: 'remoteConfig.pathStatus.notDirectoryWindowsMount',
      });
    });

    it('should resolve to nonEmpty if directory exists and has files', async () => {
      mockRemoteFileOps.getStat.mockResolvedValue({ item: { Path: 'non-empty', IsDir: true } });
      mockRemoteFileOps.getRemotePaths.mockResolvedValue({ list: [{ IsDir: false }] });

      const status = await service.inspect('/home/user/non-empty', 'remote1');

      expect(status).toEqual({
        state: 'nonEmpty',
        icon: 'folder-open',
        badgeClass: 'non-empty',
        labelKey: 'remoteConfig.pathStatus.nonEmpty',
      });
    });

    it('treats a directory containing only an empty subdirectory as non-empty', async () => {
      mockRemoteFileOps.getStat.mockResolvedValue({ item: { IsDir: true } });
      mockRemoteFileOps.getRemotePaths.mockResolvedValue({
        list: [{ Name: 'empty', IsDir: true }],
      });
      expect(await service.inspect('/parent', 'drive')).toMatchObject({ state: 'nonEmpty' });
      expect(mockRemoteFileOps.getSize).not.toHaveBeenCalled();
    });

    it.each(['stat', 'list'])('reports an unavailable path on %s failure', async operation => {
      mockRemoteFileOps.getStat.mockResolvedValue({ item: { IsDir: true } });
      (operation === 'stat'
        ? mockRemoteFileOps.getStat
        : mockRemoteFileOps.getRemotePaths
      ).mockRejectedValue(new Error('Permission denied'));
      expect(await service.inspect('/unreadable', 'drive')).toMatchObject({
        state: 'unavailable',
        labelKey: 'remoteConfig.pathStatus.unavailable',
      });
    });
  });

  describe('resolveDefaultPath', () => {
    it('reports malformed replies as unavailable rather than clean or missing', async () => {
      mockRemoteFileOps.getStat.mockResolvedValue({});
      expect(await service.inspect('/path', 'drive')).toMatchObject({ state: 'unavailable' });
      mockRemoteFileOps.getStat.mockResolvedValue({ item: { IsDir: true } });
      mockRemoteFileOps.getRemotePaths.mockResolvedValue({});
      expect(await service.inspect('/path', 'drive')).toMatchObject({ state: 'unavailable' });
    });

    it('should resolve default mount path using fallback home', async () => {
      mockApiClient.invoke.mockResolvedValue([{ name: '/home/testuser' }]);

      const result = await service.resolveDefaultPath('my-drive', 'mount');

      expect(result).toBe('/home/testuser/rclone-manager/my-drive');
    });

    it('should resolve default bisync path with stored setting and mount point', async () => {
      mockAppSettings.getSettingValue.mockResolvedValue('{home}/Sync/{remote}');
      mockApiClient.invoke.mockResolvedValue([{ name: '/Users/test' }]);

      const result = await service.resolveDefaultPath('remote:path', 'bisync');

      expect(result).toBe('/Users/test/Sync/remote-path');
    });

    it('should increment candidate suffix if default path is occupied', async () => {
      mockApiClient.invoke.mockResolvedValue([{ name: '/home/user' }]);
      mockRemoteFileOps.getStat.mockResolvedValue({ item: { Path: 'existing', IsDir: true } });
      mockRemoteFileOps.getRemotePaths
        .mockResolvedValueOnce({ list: [{ IsDir: true }] })
        .mockResolvedValueOnce({ list: [] });

      const result = await service.resolveDefaultPath('drive', 'mount');

      expect(result).toBe('/home/user/rclone-manager/drive-2');
    });

    it('skips a folder that a saved profile already uses', async () => {
      mockApiClient.invoke.mockResolvedValue([{ name: '/home/user' }]);
      remoteSettings.mockReturnValue({ drive: { mountConfigs: {} } });
      mockPathService.checkMountPathCollision.mockImplementation((candidate: string) =>
        candidate.endsWith('/drive') ? [{ remoteName: 'drive', opType: 'mount' }] : []
      );

      const result = await service.resolveDefaultPath('drive', 'mount');

      expect(result).toBe('/home/user/rclone-manager/drive-2');
      expect(mockPathService.checkMountPathCollision).toHaveBeenCalledWith(
        '/home/user/rclone-manager/drive',
        'drive',
        { drive: { mountConfigs: {} } },
        undefined,
        'mount',
        { runs: [] }
      );
    });

    it('skips a folder that a Quick Run already mounts', async () => {
      mockApiClient.invoke.mockResolvedValue([{ name: '/home/user' }]);
      const run = {
        id: 'qr-1',
        name: 'Drive',
        operationType: 'mount',
        remoteName: 'drive',
        config: { app: {}, rclone: { mountPoint: '/home/user/rclone-manager/drive' } },
      };
      quickRuns.set([run]);
      mockPathService.checkMountPathCollision.mockImplementation(
        (
          candidate: string,
          _remote: string,
          _settings: unknown,
          _profile: unknown,
          _op: unknown,
          quick: { runs: (typeof run)[] }
        ) =>
          quick.runs.some(r => r.config.rclone.mountPoint === candidate)
            ? [{ kind: 'quick_run', name: 'Drive', remoteName: 'drive', opType: 'mount', path: '' }]
            : []
      );

      expect(await service.resolveDefaultPath('drive', 'mount')).toBe(
        '/home/user/rclone-manager/drive-2'
      );
    });

    it('skips an occupied file without trying to list it as a directory', async () => {
      mockApiClient.invoke.mockResolvedValue([{ name: '/home/user' }]);
      mockRemoteFileOps.getStat.mockResolvedValueOnce({ item: { IsDir: false } });
      expect(await service.resolveDefaultPath('drive', 'mount')).toBe(
        '/home/user/rclone-manager/drive-2'
      );
      expect(mockRemoteFileOps.getRemotePaths).not.toHaveBeenCalled();
      expect(mockRemoteFileOps.getSize).not.toHaveBeenCalled();
    });

    it('rejects incomplete metadata and malformed listings when selecting a default path', async () => {
      mockRemoteFileOps.getStat.mockResolvedValue({ item: {} });
      await expect(service.resolveDefaultPath('drive', 'mount')).rejects.toThrow(
        'Invalid path stat response'
      );
      mockRemoteFileOps.getStat.mockResolvedValue({ item: { IsDir: true } });
      mockRemoteFileOps.getRemotePaths.mockResolvedValue({ list: null });
      await expect(service.resolveDefaultPath('drive', 'mount')).rejects.toThrow(
        'Invalid directory listing response'
      );
    });
  });

  describe('local directory creation through operation configuration', () => {
    it('should create directory via RemoteFileOperationsService', async () => {
      await service.createRequiredDirectoriesForOperation('mount', {
        mountPoint: '/home/user/path',
      });

      expect(mockRemoteFileOps.makeDirectory).toHaveBeenCalledWith(
        '/',
        'home/user/path',
        undefined,
        undefined,
        undefined
      );
    });

    it('should create parent directory when parentOnly is true', async () => {
      mockPathService.enginePathStyle.mockReturnValue('windows');
      await service.createRequiredDirectoriesForOperation('mount', { mountPoint: 'C:\\Mount' });

      expect(mockPathService.getParentPath).toHaveBeenCalledWith('C:\\Mount', 'windows');
      expect(mockRemoteFileOps.makeDirectory).toHaveBeenCalledWith(
        '/',
        'home/user/path',
        undefined,
        undefined,
        undefined
      );
    });

    it('should do nothing for empty path', async () => {
      await service.createRequiredDirectoriesForOperation('mount', { mountPoint: '' });

      expect(mockRemoteFileOps.makeDirectory).not.toHaveBeenCalled();
    });
  });

  it('propagates mkdir failure and sends the expected backend owner', async () => {
    const error = new Error('denied');
    mockRemoteFileOps.makeDirectory.mockRejectedValue(error);
    await expect(
      service.createRequiredDirectories(
        {
          mountConfigs: {
            Default: { rclone: { mountPoint: '/mnt/test' } },
          },
        },
        'A'
      )
    ).rejects.toBe(error);
    expect(mockRemoteFileOps.makeDirectory).toHaveBeenCalledWith(
      '/',
      'home/user/path',
      undefined,
      undefined,
      'A'
    );
  });

  it('does not select an unchecked default directory', async () => {
    mockRemoteFileOps.getStat.mockRejectedValue(new Error('offline'));
    await expect(service.resolveDefaultPath('drive', 'mount')).rejects.toThrow('offline');
  });

  describe('createRequiredDirectories', () => {
    it('should create required directories for mount and bisync configs', async () => {
      const settings = {
        mountConfigs: {
          m1: { rclone: { mountPoint: '/mnt/data' } },
        },
        bisyncConfigs: {
          b1: { rclone: { path1: '/local/sync1', path2: '/local/sync2' } },
        },
      };

      await service.createRequiredDirectories(settings);

      expect(mockRemoteFileOps.makeDirectory).toHaveBeenCalledTimes(3);
    });

    it('should pass parentOnly=true on Windows for mount configs', async () => {
      mockPathService.enginePathStyle.mockReturnValue('windows');
      const settings = {
        mountConfigs: {
          m1: { mountPoint: 'C:\\Mount' },
        },
      };

      await service.createRequiredDirectories(settings);

      expect(mockPathService.getParentPath).toHaveBeenCalledWith('C:\\Mount', 'windows');
    });
  });

  describe('createRequiredDirectoriesForOperation', () => {
    it.each(['*', 'X:', 'X:\\', 'X:/', '\\\\server\\share\\name'])(
      'does not create a local folder for the Windows drive target %s',
      async mountPoint => {
        mockPathService.enginePathStyle.mockReturnValue('windows');
        await service.createRequiredDirectoriesForOperation('mount', { mountPoint });
        expect(mockPathService.getParentPath).not.toHaveBeenCalled();
        expect(mockRemoteFileOps.makeDirectory).not.toHaveBeenCalled();
      }
    );
    it('should create required directory for mount operation', async () => {
      const rclone = { mountPoint: '/mnt/gdrive' };

      await service.createRequiredDirectoriesForOperation('mount', rclone);

      expect(mockRemoteFileOps.makeDirectory).toHaveBeenCalledWith(
        '/',
        'home/user/path',
        undefined,
        undefined,
        undefined
      );
    });

    it('should create required directories for bisync operation', async () => {
      const rclone = { path1: '/local/source', path2: '/local/dest' };

      await service.createRequiredDirectoriesForOperation('bisync', rclone);

      expect(mockRemoteFileOps.makeDirectory).toHaveBeenCalledTimes(2);
    });

    it('should do nothing if rclone config is empty or paths are remote', async () => {
      mockPathService.isTrulyLocalPath.mockReturnValue(false);
      const rclone = { mountPoint: 'remote:path' };

      await service.createRequiredDirectoriesForOperation('mount', rclone);

      expect(mockRemoteFileOps.makeDirectory).not.toHaveBeenCalled();
    });
  });

  describe('shared local directory policy', () => {
    beforeEach(() => {
      mockPathService.getParentPath.mockImplementation(pathUtils.getParentPath);
      mockPathService.splitLocalForStat.mockImplementation(pathUtils.splitLocalForStat);
      mockPathService.isTrulyLocalPath.mockImplementation((path: string, style: PathStyle) =>
        pathUtils.isTrulyLocalPath(path, new Set(['remote']), style)
      );
    });

    it('prepares Bisync directories while leaving a UNC mount name alone', async () => {
      mockPathService.enginePathStyle.mockReturnValue('windows');
      await service.createRequiredDirectories(
        {
          mountConfigs: {
            share: { rclone: { mountPoint: '\\\\server\\share\\Mount\\drive' } },
          },
          bisyncConfigs: {
            share: { rclone: { path1: '\\\\server\\share\\Sync\\one', path2: 'relative-sync' } },
            drive: { rclone: { path1: 'D:Sync\\two' } },
          },
        },
        'Windows NAS'
      );
      expect(mockRemoteFileOps.makeDirectory.mock.calls).toEqual([
        ['//server/share', 'Sync/one', undefined, undefined, 'Windows NAS'],
        ['.', 'relative-sync', undefined, undefined, 'Windows NAS'],
        ['D:', 'Sync/two', undefined, undefined, 'Windows NAS'],
      ]);
    });

    it('inspects a Windows share through its own filesystem root', async () => {
      mockPathService.enginePathStyle.mockReturnValue('windows');
      mockPathService.splitLocalForStat.mockImplementation((path: string) =>
        pathUtils.splitLocalForStat(path, 'windows')
      );
      expect(await service.inspect('\\\\server\\share\\Arşiv', 'drive')).toMatchObject({
        state: 'willCreate',
      });
      expect(mockRemoteFileOps.getStat).toHaveBeenCalledExactlyOnceWith(
        '//server/share',
        'Arşiv',
        NAMES_ONLY
      );
    });

    it('keeps profile fallback precedence, directory order, and backend ownership', async () => {
      await service.createRequiredDirectories(
        {
          mountConfigs: {
            nested: { rclone: { mountPoint: '/mnt/旅行' }, mountPoint: '/ignored' },
            legacy: { rclone: { mountPoint: '' }, mountPoint: '/legacy/Arşiv' },
            missing: null,
          },
          bisyncConfigs: {
            nested: { rclone: { path1: '', path2: 'remote:folder' }, path1: '/source' },
            legacy: { path2: '/target & more' },
          },
        },
        'NAS & 旅行'
      );
      expect(mockRemoteFileOps.makeDirectory.mock.calls).toEqual([
        ['/', 'mnt/旅行', undefined, undefined, 'NAS & 旅行'],
        ['/', 'legacy/Arşiv', undefined, undefined, 'NAS & 旅行'],
        ['/', 'source', undefined, undefined, 'NAS & 旅行'],
        ['/', 'target & more', undefined, undefined, 'NAS & 旅行'],
      ]);
      expect(mockPathService.enginePathStyle).toHaveBeenCalledOnce();
    });

    it.each([
      { operation: 'mount', config: { dest: '/mount/旅行' }, paths: ['mount/旅行'] },
      {
        operation: 'bisync',
        config: { source: '/source/Arşiv', dest: '/target/旅行' },
        paths: ['source/Arşiv', 'target/旅行'],
      },
      {
        operation: 'bisync',
        config: { srcFs: '/source/Arşiv', dstFs: '/target/旅行' },
        paths: ['source/Arşiv', 'target/旅行'],
      },
    ])('resolves $operation operation aliases', async ({ operation, config, paths }) => {
      await service.createRequiredDirectoriesForOperation(operation, config);
      expect(mockRemoteFileOps.makeDirectory.mock.calls).toEqual(
        paths.map(path => ['/', path, undefined, undefined, undefined])
      );
    });

    it('preserves explicit empty operation paths instead of using legacy aliases', async () => {
      await service.createRequiredDirectoriesForOperation('mount', {
        mountPoint: '',
        dest: '/ignored',
      });
      await service.createRequiredDirectoriesForOperation('bisync', {
        path1: '',
        source: '/ignored',
        srcFs: '/also-ignored',
        path2: null,
        dest: '/target',
      });
      expect(mockRemoteFileOps.makeDirectory.mock.calls).toEqual([
        ['/', 'target', undefined, undefined, undefined],
      ]);
    });

    it('skips missing, invalid, remote, and unsupported operation paths', async () => {
      for (const path of [null, undefined, '', 0, false, {}, [], 'remote:folder', 'saf://drive']) {
        await service.createRequiredDirectoriesForOperation('mount', { mountPoint: path });
        await service.createRequiredDirectoriesForOperation('bisync', { path1: path, path2: path });
      }
      await service.createRequiredDirectoriesForOperation('sync', { dest: '/not-required' });
      expect(mockRemoteFileOps.makeDirectory).not.toHaveBeenCalled();
    });

    it('creates Windows mount parents while keeping complete bisync paths', async () => {
      mockPathService.enginePathStyle.mockReturnValue('windows');
      await service.createRequiredDirectoriesForOperation('mount', {
        mountPoint: 'C:\\Mount\\drive',
      });
      await service.createRequiredDirectoriesForOperation('bisync', {
        path1: 'C:\\Sync\\source',
        path2: 'D:\\Sync\\target',
      });
      expect(mockRemoteFileOps.makeDirectory.mock.calls).toEqual([
        ['C:/', 'Mount', undefined, undefined, undefined],
        ['C:/', 'Sync/source', undefined, undefined, undefined],
        ['D:/', 'Sync/target', undefined, undefined, undefined],
      ]);
    });

    it('retains the captured path style and backend across awaited profile directories', async () => {
      mockPathService.enginePathStyle.mockReturnValue('windows');
      mockRemoteFileOps.makeDirectory.mockImplementationOnce(async () => {
        mockPathService.enginePathStyle.mockReturnValue('posix');
      });
      await service.createRequiredDirectories(
        {
          mountConfigs: {
            one: { mountPoint: 'C:\\Mount\\one' },
            two: { mountPoint: 'D:\\Mount\\two' },
          },
        },
        'Windows NAS'
      );
      expect(mockPathService.enginePathStyle).toHaveBeenCalledOnce();
      expect(mockPathService.getParentPath).toHaveBeenNthCalledWith(2, 'D:\\Mount\\two', 'windows');
      expect(mockRemoteFileOps.makeDirectory.mock.calls).toEqual([
        ['C:/', 'Mount', undefined, undefined, 'Windows NAS'],
        ['D:/', 'Mount', undefined, undefined, 'Windows NAS'],
      ]);
    });

    it('skips Windows mount points that have no parent directory', async () => {
      mockPathService.enginePathStyle.mockReturnValue('windows');
      for (const mountPoint of ['C:', 'C:/']) {
        await service.createRequiredDirectoriesForOperation('mount', { mountPoint });
      }
      expect(mockRemoteFileOps.makeDirectory).not.toHaveBeenCalled();
    });

    it.each(['profile', 'operation'])(
      'stops %s directory preparation after mkdir failure',
      async source => {
        const error = new Error('permission denied');
        mockRemoteFileOps.makeDirectory.mockRejectedValue(error);
        const request =
          source === 'profile'
            ? service.createRequiredDirectories(
                { bisyncConfigs: { Default: { path1: '/first', path2: '/second' } } },
                'NAS'
              )
            : service.createRequiredDirectoriesForOperation('bisync', {
                path1: '/first',
                path2: '/second',
              });
        await expect(request).rejects.toBe(error);
        expect(mockRemoteFileOps.makeDirectory).toHaveBeenCalledTimes(1);
        expect(mockRemoteFileOps.makeDirectory.mock.calls[0][1]).toBe('first');
      }
    );
  });
});

describe('inspectAfterPause', () => {
  const answer = { state: 'clean', icon: 'check', badgeClass: 'clean', labelKey: 'x' } as const;
  const request = { path: '/a', remoteName: 'r', profileName: 'p', operation: 'mount' } as const;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits for a pause, reports checking and then the answer', async () => {
    const inspect = vi.fn().mockResolvedValue(answer);
    const report = vi.fn();
    inspectAfterPause({ inspect }, request, report);

    expect(inspect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);

    expect(report.mock.calls[0][0].state).toBe('checking');
    expect(inspect).toHaveBeenCalledWith('/a', 'r', 'p', 'mount', undefined);
    expect(report).toHaveBeenLastCalledWith(answer);
  });

  it('reports the unavailable status when the check fails', async () => {
    const inspect = vi.fn().mockRejectedValue(new Error('no rclone'));
    const report = vi.fn();
    inspectAfterPause({ inspect }, request, report);
    await vi.advanceTimersByTimeAsync(300);

    expect(report).toHaveBeenLastCalledWith(PATH_INSPECTION_UNAVAILABLE);
  });

  it('does nothing once cancelled before the pause ends', async () => {
    const inspect = vi.fn().mockResolvedValue(answer);
    const report = vi.fn();
    const cancel = inspectAfterPause({ inspect }, request, report);
    cancel();
    await vi.advanceTimersByTimeAsync(300);

    expect(inspect).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it('drops the answer when cancelled while the check runs', async () => {
    let resolve: (status: unknown) => void = () => undefined;
    const inspect = vi.fn().mockReturnValue(new Promise(r => (resolve = r)));
    const report = vi.fn();
    const cancel = inspectAfterPause({ inspect }, request, report);
    await vi.advanceTimersByTimeAsync(300);
    cancel();
    resolve(answer);
    await vi.advanceTimersByTimeAsync(0);

    expect(report).toHaveBeenCalledTimes(1);
  });
});
