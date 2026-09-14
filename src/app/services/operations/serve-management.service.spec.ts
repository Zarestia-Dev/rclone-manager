import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Observable, Subject } from 'rxjs';
import { ServeManagementService } from './serve-management.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { NotificationService } from '../ui/notification.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { PathService } from '../infrastructure/platform/path.service';
import { ServeListItem, ServeListResponse, ServeStartResponse } from '@app/types';

describe('ServeManagementService', () => {
  let service: ServeManagementService;
  let apiClientMock: {
    invoke: ReturnType<typeof vi.fn>;
  };
  let notificationServiceMock: {
    showInfo: ReturnType<typeof vi.fn>;
    showSuccess: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
  };
  let serveStateChanged$: Subject<void>;
  let rcloneEngineReady$: Subject<void>;

  const mockServes: ServeListItem[] = [
    {
      id: 'http-1',
      addr: '127.0.0.1:8080',
      profile: 'Default',
      params: { fs: 'Dropbox:/photos', type: 'http' },
    },
    {
      id: 'webdav-1',
      addr: '127.0.0.1:8081',
      profile: 'Backup',
      params: { fs: 'Drive:/backup', type: 'webdav' },
    },
    {
      id: 'http-2',
      addr: '127.0.0.1:8082',
      profile: 'Media',
      params: { fs: 'Dropbox:/media', type: 'http' },
    },
  ];

  beforeEach(() => {
    serveStateChanged$ = new Subject<void>();
    rcloneEngineReady$ = new Subject<void>();

    apiClientMock = {
      invoke: vi.fn().mockResolvedValue([]),
    };

    notificationServiceMock = {
      showInfo: vi.fn(),
      showSuccess: vi.fn(),
      showError: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        ServeManagementService,
        { provide: ApiClientService, useValue: apiClientMock },
        { provide: NotificationService, useValue: notificationServiceMock },
        {
          provide: TranslateService,
          useValue: {
            instant: (k: string, p?: Record<string, unknown>): string =>
              `${k}:${p ? JSON.stringify(p) : ''}`,
          },
        },
        {
          provide: EventListenersService,
          useValue: {
            listenToServeStateChanged: (): Observable<void> => serveStateChanged$,
            listenToRcloneEngineReady: (): Observable<void> => rcloneEngineReady$,
          },
        },
        {
          provide: PathService,
          useValue: {
            normalizeFs: (fs?: string): string => fs ?? '',
            getRemoteNameFromFs: (fs?: string): string => (fs ? fs.split(':')[0] : ''),
          },
        },
      ],
    });

    service = TestBed.inject(ServeManagementService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should be created and trigger initial refreshServes', () => {
    expect(service).toBeTruthy();
    expect(apiClientMock.invoke).toHaveBeenCalledWith('get_cached_serves', undefined);
  });

  describe('stopServe', () => {
    it('invokes stop_serve with serverId and remoteName, and shows success notification', async () => {
      apiClientMock.invoke.mockResolvedValueOnce('success');

      await service.stopServe('http-9cc91a83', 'Dropbox');

      expect(apiClientMock.invoke).toHaveBeenCalledWith('stop_serve', {
        serverId: 'http-9cc91a83',
        remoteName: 'Dropbox',
      });
      expect(notificationServiceMock.showSuccess).toHaveBeenCalled();
    });

    it('shows error notification when stop_serve fails', async () => {
      apiClientMock.invoke.mockRejectedValueOnce(new Error('rpc error'));

      await expect(service.stopServe('http-9cc91a83', 'Dropbox')).rejects.toThrow('rpc error');
      expect(notificationServiceMock.showError).toHaveBeenCalled();
    });
  });

  describe('stopAllServes', () => {
    it('invokes stop_all_serves with normal context and notifies', async () => {
      apiClientMock.invoke.mockResolvedValueOnce('success');

      await service.stopAllServes('normal');

      expect(apiClientMock.invoke).toHaveBeenCalledWith('stop_all_serves', {
        context: 'normal',
      });
      expect(notificationServiceMock.showSuccess).toHaveBeenCalled();
    });

    it('shows error notification when stop_all_serves fails', async () => {
      apiClientMock.invoke.mockRejectedValueOnce(new Error('stop all failed'));

      await expect(service.stopAllServes('normal')).rejects.toThrow('stop all failed');
      expect(notificationServiceMock.showError).toHaveBeenCalled();
    });
  });

  describe('startServeProfile', () => {
    it('invokes start_serve_profile and shows success message', async () => {
      const startResp: ServeStartResponse = { id: 'http-1', addr: '127.0.0.1:8080' };
      apiClientMock.invoke.mockResolvedValueOnce(startResp);

      const res = await service.startServeProfile('Dropbox', 'Default');

      expect(res).toEqual(startResp);
      expect(apiClientMock.invoke).toHaveBeenCalledWith('start_serve_profile', {
        params: { remoteName: 'Dropbox', profileName: 'Default' },
      });
      expect(notificationServiceMock.showSuccess).toHaveBeenCalled();
    });
  });

  describe('refreshServesFromCache & refreshServes', () => {
    it('updates runningServes signal when cache returns an array', async () => {
      apiClientMock.invoke.mockResolvedValueOnce(mockServes);

      await service.refreshServesFromCache();

      expect(service.runningServes()).toHaveLength(3);
      expect(service.runningServes()[0].id).toBe('http-1');
    });

    it('updates runningServes signal when cache returns an object with list', async () => {
      const response: ServeListResponse = { list: mockServes };
      apiClientMock.invoke.mockResolvedValueOnce(response);

      await service.refreshServesFromCache();

      expect(service.runningServes()).toHaveLength(3);
    });

    it('falls back to listServes API when cache refresh fails', async () => {
      apiClientMock.invoke
        .mockRejectedValueOnce(new Error('cache error'))
        .mockResolvedValueOnce({ list: [mockServes[0]] });

      await service.refreshServes();

      expect(service.runningServes()).toHaveLength(1);
      expect(service.runningServes()[0].id).toBe('http-1');
    });
  });

  describe('servesByRemote computed & getServesForRemoteProfile', () => {
    beforeEach(async () => {
      apiClientMock.invoke.mockResolvedValueOnce(mockServes);
      await service.refreshServesFromCache();
    });

    it('groups serves by remote name correctly', () => {
      const grouped = service.servesByRemote();
      expect(grouped['Dropbox']).toHaveLength(2);
      expect(grouped['Drive']).toHaveLength(1);
    });

    it('filters serves by remote and profile in getServesForRemoteProfile', () => {
      const allDropbox = service.getServesForRemoteProfile('Dropbox');
      expect(allDropbox).toHaveLength(2);

      const defaultDropbox = service.getServesForRemoteProfile('Dropbox', 'Default');
      expect(defaultDropbox).toHaveLength(1);
      expect(defaultDropbox[0].id).toBe('http-1');

      const nonExistent = service.getServesForRemoteProfile('Dropbox', 'NonExistent');
      expect(nonExistent).toHaveLength(0);
    });
  });

  describe('Event listeners', () => {
    it('refreshes serves when serveStateChanged event fires', async () => {
      apiClientMock.invoke.mockResolvedValueOnce([mockServes[0]]);

      serveStateChanged$.next();

      // Wait a microtask tick for async handler
      await Promise.resolve();
      expect(apiClientMock.invoke).toHaveBeenCalledWith('get_cached_serves', undefined);
    });

    it('refreshes serves when rcloneEngineReady event fires', async () => {
      apiClientMock.invoke.mockResolvedValueOnce([mockServes[0]]);

      rcloneEngineReady$.next();

      await Promise.resolve();
      expect(apiClientMock.invoke).toHaveBeenCalledWith('get_cached_serves', undefined);
    });
  });

  describe('Other methods', () => {
    it('getServeTypes invokes get_serve_types', async () => {
      apiClientMock.invoke.mockResolvedValueOnce(['http', 'webdav', 'ftp']);
      const types = await service.getServeTypes();
      expect(types).toEqual(['http', 'webdav', 'ftp']);
      expect(apiClientMock.invoke).toHaveBeenCalledWith('get_serve_types', undefined);
    });

    it('forceCheckServes invokes force_check_serves', async () => {
      apiClientMock.invoke.mockResolvedValueOnce(undefined);
      await service.forceCheckServes();
      expect(apiClientMock.invoke).toHaveBeenCalledWith('force_check_serves', undefined);
    });

    it('renameProfileInServeCache invokes rename_serve_profile_in_cache', async () => {
      apiClientMock.invoke.mockResolvedValueOnce(2);
      const count = await service.renameProfileInServeCache('Dropbox', 'Old', 'New');
      expect(count).toBe(2);
      expect(apiClientMock.invoke).toHaveBeenCalledWith('rename_serve_profile_in_cache', {
        remoteName: 'Dropbox',
        oldName: 'Old',
        newName: 'New',
      });
    });
  });
});
