import { BackendService } from '../infrastructure/system/backend.service';
import { VaultService } from '../security/vault.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { of, Subject, Observable } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { RemoteManagementService } from './remote-management.service';
import { RemoteFileOperationsService } from './remote-file-operations.service';
import { PathService } from '../infrastructure/platform/path.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { NotificationService } from '../ui/notification.service';
import { BackendTranslationService } from '../i18n/backend-translation.service';
import { SseClientService } from '../infrastructure/platform/sse-client.service';
import { FsInfo } from '@app/types';

describe('RemoteManagementService', () => {
  let service: RemoteManagementService;
  let remoteOpsSpy: {
    getFsInfo: ReturnType<typeof vi.fn>;
  };
  let pathService: PathService;
  let switched: Subject<void>;
  const accessible = signal(true);

  const mockFsInfoDrive: FsInfo = {
    Name: 'drive',
    Root: '',
    Precision: 1,
    Hashes: ['MD5'],
    Features: {
      About: true,
      BucketBased: false,
      CanHaveEmptyDirectories: true,
      CleanUp: true,
      PublicLink: true,
      Copy: true,
      Move: true,
      Purge: true,
    },
  };

  beforeEach(() => {
    switched = new Subject();
    accessible.set(true);
    remoteOpsSpy = {
      getFsInfo: vi.fn().mockResolvedValue(mockFsInfoDrive),
    };

    TestBed.configureTestingModule({
      providers: [
        RemoteManagementService,
        PathService,
        { provide: BackendService, useValue: { isWindows: (): boolean => false } },
        { provide: VaultService, useValue: { isAccessible: accessible } },
        {
          provide: EventListenersService,
          useValue: {
            listenToBackendSwitched: (): typeof switched => switched,
            listenToVaultState: (): Observable<never> => of(),
          },
        },
        { provide: RemoteFileOperationsService, useValue: remoteOpsSpy },
        {
          provide: ApiClientService,
          useValue: {
            invoke: vi.fn().mockResolvedValue([{ name: 'Local', isActive: true }]),
            get: vi.fn(),
            post: vi.fn(),
          },
        },
        {
          provide: NotificationService,
          useValue: { showSuccess: vi.fn(), showError: vi.fn(), showInfo: vi.fn() },
        },
        {
          provide: TranslateService,
          useValue: { instant: vi.fn((k: string) => k), get: vi.fn(() => of('')) },
        },
        {
          provide: BackendTranslationService,
          useValue: { translateError: vi.fn((k: string) => k) },
        },
        { provide: SseClientService, useValue: { listen: vi.fn(() => of()) } },
      ],
    });

    service = TestBed.inject(RemoteManagementService);
    pathService = TestBed.inject(PathService);
    pathService.setRemoteNames(['gdrive', 'localremote']);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('keeps background metadata concurrency bounded and yields between batches', async () => {
    vi.useFakeTimers();
    const names = Array.from({ length: 10 }, (_, i) => `remote-${i}`);
    pathService.setRemoteNames(names);
    const pending: (() => void)[] = [];
    remoteOpsSpy.getFsInfo.mockImplementation(
      () =>
        new Promise<FsInfo>(resolve => {
          pending.push(() => resolve(mockFsInfoDrive));
        })
    );
    for (const name of names) service.getFeaturesSignal(name);
    expect(remoteOpsSpy.getFsInfo).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(remoteOpsSpy.getFsInfo).toHaveBeenCalledTimes(4);
    pending.splice(0).forEach(finish => finish());
    await vi.advanceTimersByTimeAsync(1);
    expect(remoteOpsSpy.getFsInfo).toHaveBeenCalledTimes(8);
    pending.splice(0).forEach(finish => finish());
    await vi.advanceTimersByTimeAsync(1);
    expect(remoteOpsSpy.getFsInfo).toHaveBeenCalledTimes(10);
    pending.splice(0).forEach(finish => finish());
    await vi.runAllTimersAsync();
  });

  it('does not invalidate other remote feature consumers when one response arrives', async () => {
    pathService.setRemoteNames(['a', 'b']);
    const a = service.getFeaturesSignal('a');
    const b = service.getFeaturesSignal('b');
    let reads = 0;
    const observedB = computed(() => {
      reads++;
      return b();
    });
    const before = observedB();
    await service.getFeatures('a');
    expect(a().About).toBe(true);
    expect(observedB()).toBe(before);
    expect(reads).toBe(1);
  });

  it('retains existing signal subscribers across cache invalidation', async () => {
    const features = service.getFeaturesSignal('gdrive');
    await service.getFeatures('gdrive');
    expect(features().About).toBe(true);
    service.clearCache('gdrive:');
    expect(features().loading).toBe(true);
    expect(service.getFeaturesSignal('gdrive')).toBe(features);
    await service.getFeatures('gdrive');
    expect(features().About).toBe(true);
  });

  it.each([false, true])(
    'discards stale metadata after cache invalidation (all = %s)',
    async all => {
      let finish!: (value: FsInfo) => void;
      remoteOpsSpy.getFsInfo.mockReturnValueOnce(
        new Promise<FsInfo>(resolve => {
          finish = resolve;
        })
      );
      const features = service.getFeaturesSignal('gdrive');
      const old = service.getFeatures('gdrive');
      const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
      service.clearCache(all ? undefined : 'gdrive');
      const freshInfo = { ...mockFsInfoDrive, Hashes: ['SHA-256'] };
      remoteOpsSpy.getFsInfo.mockResolvedValueOnce(freshInfo);
      await service.getFeatures('gdrive');
      finish(mockFsInfoDrive);
      await rejected;
      expect(features().Hashes).toEqual(['SHA-256']);
      expect(await service.getFsInfo('gdrive')).toBe(freshInfo);
    }
  );

  it('still fetches full metadata for an explicit local-path request', async () => {
    const features = await service.getFeatures('/tmp/data');
    expect(features.IsLocal).toBe(true);
    expect(features.Hashes).toEqual(['MD5']);
    expect(remoteOpsSpy.getFsInfo).toHaveBeenCalledWith('/tmp/data', 'dashboard', undefined);
  });

  it('drops queued work when its cache is cleared or the service is destroyed', async () => {
    vi.useFakeTimers();
    service.getFeaturesSignal('gdrive');
    service.clearCache('gdrive');
    await vi.runAllTimersAsync();
    expect(remoteOpsSpy.getFsInfo).not.toHaveBeenCalled();
    service.getFeaturesSignal('gdrive');
    TestBed.resetTestingModule();
    await vi.runAllTimersAsync();
    expect(remoteOpsSpy.getFsInfo).not.toHaveBeenCalled();
  });

  it('shares a single fs/info request between metadata and feature readers', async () => {
    let finish!: (info: FsInfo) => void;
    remoteOpsSpy.getFsInfo.mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve;
      })
    );
    const info = service.getFsInfo('gdrive');
    const features = service.getFeatures('gdrive');
    expect(remoteOpsSpy.getFsInfo).toHaveBeenCalledTimes(1);
    finish(mockFsInfoDrive);
    expect(await info).toBe(mockFsInfoDrive);
    expect((await features).Hashes).toEqual(['MD5']);
  });

  it('clears metadata on backend changes without needing the facade', async () => {
    const features = service.getFeaturesSignal('gdrive');
    await service.getFeatures('gdrive');
    switched.next();
    pathService.setRemoteNames(['gdrive']);
    expect(features().loading).toBe(true);
    await service.getFeatures('gdrive');
    expect(remoteOpsSpy.getFsInfo).toHaveBeenCalledTimes(2);
  });

  it('does not enqueue feature requests while the vault is inaccessible', async () => {
    vi.useFakeTimers();
    accessible.set(false);
    const features = computed(() => service.getFeaturesSignal('gdrive')());
    expect(features().loading).toBe(true);
    await vi.runAllTimersAsync();
    expect(remoteOpsSpy.getFsInfo).not.toHaveBeenCalled();
    accessible.set(true);
    features();
    await vi.runAllTimersAsync();
    expect(features().loading).toBe(false);
  });

  it('recovers when a remote is read before the catalogue arrives', async () => {
    pathService.setRemoteNames([]);
    const features = computed(() => service.getFeaturesSignal('gdrive')());
    expect(features().IsLocal).toBe(true);
    pathService.setRemoteNames(['gdrive']);
    expect(features().loading).toBe(true);
    await vi.waitFor(() => expect(features().loading).toBe(false));
    expect(features().IsLocal).toBe(false);
    expect(features().About).toBe(true);
  });

  it('publishes known remote names at the data source, independently of Main', async () => {
    pathService.setRemoteNames([]);
    const api = vi.mocked(TestBed.inject(ApiClientService).invoke);
    api.mockResolvedValueOnce({ independent: { type: 's3' } });
    await service.getAllRemoteConfigs();
    expect(pathService.isLocalPath('independent:')).toBe(false);
    expect(remoteOpsSpy.getFsInfo).not.toHaveBeenCalled();
  });

  it('does not restore old path names when a previous backend responds late', async () => {
    let finish!: (configs: Record<string, unknown>) => void;
    const api = vi.mocked(TestBed.inject(ApiClientService).invoke);
    api.mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve;
      })
    );
    const old = service.getAllRemoteConfigs();
    const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    switched.next();
    api.mockResolvedValueOnce({ current: { type: 's3' } });
    await service.getAllRemoteConfigs();
    finish({ stale: { type: 'drive' } });
    await rejected;
    expect(pathService.isLocalPath('current:')).toBe(false);
    expect(pathService.isLocalPath('stale:')).toBe(true);
  });

  it('shares catalogue requests from different screens', async () => {
    const api = vi.mocked(TestBed.inject(ApiClientService).invoke);
    api.mockResolvedValueOnce({ gdrive: { type: 'drive' } });
    const [first, second] = await Promise.all([
      service.getAllRemoteConfigs(),
      service.getAllRemoteConfigs(),
    ]);
    expect(first).toBe(second);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('invalidates provider fields when the backend changes', async () => {
    const api = vi.mocked(TestBed.inject(ApiClientService).invoke);
    api.mockResolvedValueOnce({
      providers: [{ Name: 'drive', Description: 'old', Options: [{ Name: 'old' }] }],
    });
    expect((await service.getRemoteConfigFields('drive'))[0].Name).toBe('old');
    switched.next();
    api.mockResolvedValueOnce({
      providers: [{ Name: 'drive', Description: 'new', Options: [{ Name: 'new' }] }],
    });
    expect((await service.getRemoteConfigFields('drive'))[0].Name).toBe('new');
  });

  it.each(['getRemoteTypes', 'getOAuthSupportedRemotes'] as const)(
    '%s preserves embedded overview data and tolerates older providers',
    async method => {
      const overview = { Tier: 'Tier 1', Features: ['Copy'], Hashes: ['md5'], Virtual: false };
      const Options = [{ Name: 'token', Help: 'OAuth Access Token as a JSON blob.' }];
      vi.mocked(TestBed.inject(ApiClientService).invoke).mockResolvedValueOnce({
        providers: [
          { Name: 'drive', Description: 'Google Drive', Overview: overview, Options },
          { Name: 'legacy', Description: 'Legacy', Options },
          { Name: 'empty', Description: 'Empty', Overview: null, Options },
        ],
      });
      expect(await service[method]()).toEqual([
        { name: 'drive', description: 'Google Drive', overview },
        { name: 'legacy', description: 'Legacy', overview: undefined },
        { name: 'empty', description: 'Empty', overview: null },
      ]);
    }
  );

  it('shares one provider request between OAuth, type and configuration-field readers', async () => {
    const api = vi.mocked(TestBed.inject(ApiClientService).invoke);
    const options = [{ Name: 'token', Help: 'OAuth Access Token as a JSON blob.' }];
    const overview = { Tier: 'Tier 1' };
    api.mockResolvedValueOnce({
      providers: [
        { Name: 'drive', Description: 'Google Drive', Options: options, Overview: overview },
        { Name: 'local', Description: 'Local' },
      ],
    });
    const [types, oauth, fields] = await Promise.all([
      service.getRemoteTypes(),
      service.getOAuthSupportedRemotes(),
      service.getRemoteConfigFields('drive'),
    ]);
    expect(types).toHaveLength(2);
    expect(oauth).toEqual([{ name: 'drive', description: 'Google Drive', overview }]);
    expect(fields).toEqual(options);
    expect(await service.getOAuthSupportedRemotes()).toEqual(oauth);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api.mock.calls[0][0]).toBe('get_remote_types');
  });

  it('matches the existing OAuth schema filter without treating every token field as OAuth', async () => {
    const api = vi.mocked(TestBed.inject(ApiClientService).invoke);
    api.mockResolvedValueOnce({
      providers: [
        { Name: 'missing-options', Description: '', Options: null },
        { Name: 'empty-options', Description: '', Options: [] },
        { Name: 'missing-help', Description: '', Options: [{ Name: 'token' }] },
        { Name: 'null-help', Description: '', Options: [{ Name: 'token', Help: null }] },
        { Name: 'api-token', Description: '', Options: [{ Name: 'token', Help: 'API token' }] },
        {
          Name: 'other-option',
          Description: '',
          Options: [{ Name: 'other', Help: 'OAuth Access Token as a JSON blob' }],
        },
        {
          Name: 'oauth',
          Description: 'OAuth provider',
          Options: [
            { Name: 'token', Help: 'Help: OAuth Access Token as a JSON blob.\nMore help.' },
          ],
        },
      ],
    });
    expect(await service.getOAuthSupportedRemotes()).toEqual([
      { name: 'oauth', description: 'OAuth provider', overview: undefined },
    ]);
  });

  it('refreshes the OAuth catalogue when the active backend changes', async () => {
    const api = vi.mocked(TestBed.inject(ApiClientService).invoke);
    const Options = [{ Name: 'token', Help: 'OAuth Access Token as a JSON blob' }];
    api.mockResolvedValueOnce({ providers: [{ Name: 'drive', Description: 'Drive', Options }] });
    await service.getRemoteTypes();
    expect((await service.getOAuthSupportedRemotes())[0].name).toBe('drive');
    switched.next();
    api.mockResolvedValueOnce({ providers: [{ Name: 'pcloud', Description: 'pCloud', Options }] });
    expect((await service.getOAuthSupportedRemotes())[0].name).toBe('pcloud');
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('allows OAuth catalogue reads to retry after provider loading fails', async () => {
    const api = vi.mocked(TestBed.inject(ApiClientService).invoke);
    api.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ providers: [] });
    await expect(service.getOAuthSupportedRemotes()).rejects.toThrow('offline');
    expect(await service.getOAuthSupportedRemotes()).toEqual([]);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('rejects stale OAuth readers and retains the new backend catalogue', async () => {
    const api = vi.mocked(TestBed.inject(ApiClientService).invoke);
    let finish!: (value: unknown) => void;
    api.mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve;
      })
    );
    const stale = service.getOAuthSupportedRemotes();
    const rejected = expect(stale).rejects.toMatchObject({ name: 'AbortError' });
    switched.next();
    api.mockResolvedValueOnce({ providers: [] });
    expect(await service.getOAuthSupportedRemotes()).toEqual([]);
    finish({
      providers: [
        {
          Name: 'stale',
          Description: 'Stale',
          Options: [{ Name: 'token', Help: 'OAuth Access Token as a JSON blob' }],
        },
      ],
    });
    await rejected;
    expect(await service.getOAuthSupportedRemotes()).toEqual([]);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('releases metadata queue slots after invalidation even if old transports never complete', async () => {
    vi.useFakeTimers();
    const names = ['a', 'b', 'c', 'd', 'fresh'];
    pathService.setRemoteNames(names);
    remoteOpsSpy.getFsInfo.mockImplementation(() => new Promise(() => undefined));
    names.slice(0, 4).forEach(name => service.getFeaturesSignal(name));
    await vi.advanceTimersByTimeAsync(0);
    expect(remoteOpsSpy.getFsInfo).toHaveBeenCalledTimes(4);
    service.clearCache();
    remoteOpsSpy.getFsInfo.mockResolvedValue(mockFsInfoDrive);
    const fresh = service.getFeaturesSignal('fresh');
    await vi.runAllTimersAsync();
    expect(fresh().loading).toBe(false);
    expect(remoteOpsSpy.getFsInfo).toHaveBeenCalledTimes(5);
  });

  it('cancels stale fs/info readers instead of returning the old result', async () => {
    remoteOpsSpy.getFsInfo.mockReturnValueOnce(new Promise(() => undefined));
    const old = service.getFsInfo('gdrive');
    const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    service.clearCache('gdrive');
    await rejected;
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('getFeaturesSignal', () => {
    it('should return initial fallback signal and trigger async load for cloud remote', async () => {
      const sig = service.getFeaturesSignal('gdrive');
      expect(sig).toBeDefined();

      // Initial read returns fallback with loading: true
      const initial = sig();
      expect(initial.CleanUp).toBe(false);
      expect(initial.loading).toBe(true);

      // Reading a signal must leave the current render free of backend work.
      expect(remoteOpsSpy.getFsInfo).not.toHaveBeenCalled();

      // Wait for async getFeatures to complete
      await vi.waitFor(() => {
        expect(sig().loading).toBe(false);
      });

      expect(remoteOpsSpy.getFsInfo).toHaveBeenCalledWith('gdrive:', 'dashboard', undefined);
      const loaded = sig();
      expect(loaded.CleanUp).toBe(true);
      expect(loaded.PublicLink).toBe(true);
      expect(loaded.Purge).toBe(true);
      expect(loaded.Copy).toBe(true);
      expect(loaded.Move).toBe(true);
      expect(loaded.Hashes).toEqual(['MD5']);
    });

    it('should handle local paths synchronously without calling getFsInfo', () => {
      const sig = service.getFeaturesSignal('/home/user/documents');
      const feats = sig();
      expect(feats.IsLocal).toBe(true);
      expect(feats.loading).toBe(false);
      expect(remoteOpsSpy.getFsInfo).not.toHaveBeenCalled();
    });

    it('should reuse existing signal for the same cache key', () => {
      const sig1 = service.getFeaturesSignal('gdrive');
      const sig2 = service.getFeaturesSignal('gdrive');
      expect(sig1).toBe(sig2);
    });

    it('should not throw NG0600 when getFeaturesSignal is read inside a computed', async () => {
      const computedFeatures = computed(() => service.getFeaturesSignal('gdrive')());

      expect(() => computedFeatures()).not.toThrow();
      expect(computedFeatures().loading).toBe(true);

      await vi.waitFor(() => {
        expect(computedFeatures().loading).toBe(false);
      });
      expect(computedFeatures().CleanUp).toBe(true);
    });
  });

  describe('hasFeature', () => {
    it('should check features dynamically and return false while loading', async () => {
      expect(service.hasFeature('gdrive', 'CleanUp')).toBe(false);
      expect(service.hasFeature('gdrive', 'Purge')).toBe(false);

      await vi.waitFor(() => {
        expect(service.hasFeature('gdrive', 'CleanUp')).toBe(true);
      });

      expect(service.hasFeature('gdrive', 'CleanUp')).toBe(true);
      expect(service.hasFeature('gdrive', 'Purge')).toBe(true);
      expect(service.hasFeature('gdrive', 'BucketBased')).toBe(false);
      expect(service.hasFeature('gdrive', 'NonExistentFeature')).toBe(false);
      expect(service.hasFeature('gdrive', 'PublicLink')).toBe(true);
    });

    it('should not throw NG0600 when hasFeature is called inside a computed', async () => {
      const computedHasFeature = computed(() => service.hasFeature('gdrive', 'CleanUp'));

      expect(() => computedHasFeature()).not.toThrow();
      expect(computedHasFeature()).toBe(false);

      await vi.waitFor(() => {
        expect(computedHasFeature()).toBe(true);
      });
    });
  });

  it('does not retry failed metadata on signal reads, but allows an explicit retry', async () => {
    remoteOpsSpy.getFsInfo.mockRejectedValueOnce(new Error('offline'));
    expect((await service.getFeatures('gdrive')).About).toBe(false);
    const features = service.getFeaturesSignal('gdrive');
    expect(features().loading).toBe(false);
    expect(remoteOpsSpy.getFsInfo).toHaveBeenCalledTimes(1);
    expect((await service.getFeatures('gdrive')).About).toBe(true);
    expect(remoteOpsSpy.getFsInfo).toHaveBeenCalledTimes(2);
    expect(features().About).toBe(true);
  });

  describe('getFeatures deduplication and error handling', () => {
    it('should deduplicate concurrent in-flight requests for the same remote', async () => {
      let resolveFirst!: (value: FsInfo) => void;
      remoteOpsSpy.getFsInfo.mockReturnValueOnce(
        new Promise<FsInfo>(res => {
          resolveFirst = res;
        })
      );

      const p1 = service.getFeatures('gdrive');
      const p2 = service.getFeatures('gdrive');

      expect(remoteOpsSpy.getFsInfo).toHaveBeenCalledTimes(1);

      resolveFirst(mockFsInfoDrive);
      const [res1, res2] = await Promise.all([p1, p2]);

      expect(res1).toEqual(res2);
      expect(res1.CleanUp).toBe(true);
      expect(res1.Purge).toBe(true);
    });

    it('should return fallback if getFsInfo fails', async () => {
      remoteOpsSpy.getFsInfo.mockRejectedValueOnce(new Error('Network error'));

      const feats = await service.getFeatures('gdrive');
      expect(feats.CleanUp).toBe(false);
      expect(feats.loading).toBe(false);
      expect(feats.About).toBe(false);
    });
  });

  describe('clearCache', () => {
    it('should clear specific remote from cache and inFlight map', async () => {
      await service.getFeatures('gdrive');
      expect(remoteOpsSpy.getFsInfo).toHaveBeenCalledTimes(1);

      service.clearCache('gdrive');

      // Subsequent call should fetch again
      await service.getFeatures('gdrive');
      expect(remoteOpsSpy.getFsInfo).toHaveBeenCalledTimes(2);
    });
  });
});
