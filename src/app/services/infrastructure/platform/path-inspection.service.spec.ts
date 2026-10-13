import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PathInspectionService } from './path-inspection.service';
import { ApiClientService } from './api-client.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { RemoteFileOperationsService } from '../../remote/remote-file-operations.service';
import { RemoteFacadeService } from '../../facade/remote-facade.service';
import { PathService } from './path.service';

describe('PathInspectionService', () => {
  let service: PathInspectionService;
  let mockApiClient: { invoke: ReturnType<typeof vi.fn> };
  let mockAppSettings: { getSettingValue: ReturnType<typeof vi.fn> };
  let mockRemoteFileOps: {
    getStat: ReturnType<typeof vi.fn>;
    getSize: ReturnType<typeof vi.fn>;
    makeDirectory: ReturnType<typeof vi.fn>;
  };
  let mockRemoteFacade: {
    checkMountPathCollision: ReturnType<typeof vi.fn>;
  };
  let mockPathService: {
    splitLocalForStat: ReturnType<typeof vi.fn>;
    enginePathStyle: ReturnType<typeof vi.fn>;
    normalizeForPlatform: ReturnType<typeof vi.fn>;
    getParentPath: ReturnType<typeof vi.fn>;
    isTrulyLocalPath: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockApiClient = { invoke: vi.fn() };
    mockAppSettings = { getSettingValue: vi.fn().mockResolvedValue(null) };
    mockRemoteFileOps = {
      getStat: vi.fn().mockResolvedValue({ item: null }),
      getSize: vi.fn().mockResolvedValue({ count: 0 }),
      makeDirectory: vi.fn().mockResolvedValue(undefined),
    };
    mockRemoteFacade = {
      checkMountPathCollision: vi.fn().mockReturnValue([]),
    };
    mockPathService = {
      splitLocalForStat: vi.fn().mockReturnValue({ root: '/', relative: 'home/user/path' }),
      enginePathStyle: vi.fn().mockReturnValue('posix'),
      normalizeForPlatform: vi.fn().mockImplementation((p: string) => p),
      getParentPath: vi.fn().mockReturnValue('/home/user'),
      isTrulyLocalPath: vi.fn().mockReturnValue(true),
    };

    TestBed.configureTestingModule({
      providers: [
        PathInspectionService,
        { provide: ApiClientService, useValue: mockApiClient },
        { provide: AppSettingsService, useValue: mockAppSettings },
        { provide: RemoteFileOperationsService, useValue: mockRemoteFileOps },
        { provide: RemoteFacadeService, useValue: mockRemoteFacade },
        { provide: PathService, useValue: mockPathService },
      ],
    });

    service = TestBed.inject(PathInspectionService);
  });

  describe('inspect', () => {
    it('should return colliding if mount collision is detected', async () => {
      mockRemoteFacade.checkMountPathCollision.mockReturnValue([
        { remoteName: 'otherRemote', opType: 'mount' },
      ]);

      const status = await service.inspect('/home/user/colliding', 'remote1');

      expect(status).toEqual({
        state: 'colliding',
        details: 'otherRemote (mount)',
        icon: 'warning',
        badgeClass: 'colliding',
        labelKey: 'remoteConfig.pathStatus.colliding',
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
    });

    it('should resolve to clean if directory exists and has 0 items', async () => {
      mockRemoteFileOps.getStat.mockResolvedValue({ item: { Path: 'clean-path', IsDir: true } });
      mockRemoteFileOps.getSize.mockResolvedValue({ count: 0, bytes: 0 });

      const status = await service.inspect('/home/user/clean-path', 'remote1');

      expect(status).toEqual({
        state: 'clean',
        icon: 'check-circle',
        badgeClass: 'clean',
        labelKey: 'remoteConfig.pathStatus.clean',
      });
    });

    it('should resolve to nonEmpty if directory exists and has files', async () => {
      mockRemoteFileOps.getStat.mockResolvedValue({ item: { Path: 'non-empty', IsDir: true } });
      mockRemoteFileOps.getSize.mockResolvedValue({ count: 3, bytes: 1024 });

      const status = await service.inspect('/home/user/non-empty', 'remote1');

      expect(status).toEqual({
        state: 'nonEmpty',
        icon: 'folder-open',
        badgeClass: 'non-empty',
        labelKey: 'remoteConfig.pathStatus.nonEmpty',
      });
    });

    it('should return willCreate on API getStat error', async () => {
      mockRemoteFileOps.getStat.mockRejectedValue(new Error('Network failure'));

      const status = await service.inspect('/home/user/error-path', 'remote1');

      expect(status).toEqual({
        state: 'willCreate',
        icon: 'folder-plus',
        badgeClass: 'will-create',
        labelKey: 'remoteConfig.pathStatus.willCreate',
      });
    });

    it('should fall back to clean if getSize throws an error when directory exists', async () => {
      mockRemoteFileOps.getStat.mockResolvedValue({ item: { Path: 'unreadable', IsDir: true } });
      mockRemoteFileOps.getSize.mockRejectedValue(new Error('Permission denied'));

      const status = await service.inspect('/home/user/unreadable', 'remote1');

      expect(status).toEqual({
        state: 'clean',
        icon: 'check-circle',
        badgeClass: 'clean',
        labelKey: 'remoteConfig.pathStatus.clean',
      });
    });
  });

  describe('resolveDefaultPath', () => {
    it('should resolve default mount path using fallback home', async () => {
      mockApiClient.invoke.mockResolvedValue([{ name: '/home/testuser' }]);

      const result = await service.resolveDefaultPath('my-drive', 'mount');

      expect(result).toBe('/home/testuser/rclone-manager/my-drive');
    });

    it('should resolve default bisync path with stored setting and mount point', async () => {
      mockAppSettings.getSettingValue.mockResolvedValue('{home}/Sync/{remote}');
      mockApiClient.invoke.mockResolvedValue([{ mount_point: '/Users/test' }]);

      const result = await service.resolveDefaultPath('remote:path', 'bisync');

      expect(result).toBe('/Users/test/Sync/remote-path');
    });

    it('should increment candidate suffix if default path is occupied', async () => {
      mockApiClient.invoke.mockResolvedValue([{ name: '/home/user' }]);
      mockRemoteFileOps.getStat.mockResolvedValue({ item: { Path: 'existing' } });
      mockRemoteFileOps.getSize
        .mockResolvedValueOnce({ count: 5 })
        .mockResolvedValueOnce({ count: 0 });

      const result = await service.resolveDefaultPath('drive', 'mount');

      expect(result).toBe('/home/user/rclone-manager/drive-2');
    });
  });

  describe('createLocalDirectory', () => {
    it('should create directory via RemoteFileOperationsService', async () => {
      await service.createLocalDirectory('/home/user/path', false);

      expect(mockRemoteFileOps.makeDirectory).toHaveBeenCalledWith('/', 'home/user/path');
    });

    it('should create parent directory when parentOnly is true', async () => {
      await service.createLocalDirectory('/home/user/path', true);

      expect(mockPathService.getParentPath).toHaveBeenCalledWith('/home/user/path');
      expect(mockRemoteFileOps.makeDirectory).toHaveBeenCalledWith('/', 'home/user/path');
    });

    it('should do nothing for empty path', async () => {
      await service.createLocalDirectory('', false);

      expect(mockRemoteFileOps.makeDirectory).not.toHaveBeenCalled();
    });
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

      expect(mockPathService.getParentPath).toHaveBeenCalledWith('C:\\Mount');
    });
  });

  describe('createRequiredDirectoriesForOperation', () => {
    it('should create required directory for mount operation', async () => {
      const rclone = { mountPoint: '/mnt/gdrive' };

      await service.createRequiredDirectoriesForOperation('mount', rclone);

      expect(mockRemoteFileOps.makeDirectory).toHaveBeenCalledWith('/', 'home/user/path');
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

  describe('isTrulyLocalPath', () => {
    it('should delegate to PathService', () => {
      const result = service.isTrulyLocalPath('/local/dir', 'posix');

      expect(mockPathService.isTrulyLocalPath).toHaveBeenCalledWith('/local/dir', 'posix');
      expect(result).toBe(true);
    });
  });
});
