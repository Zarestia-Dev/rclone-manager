import { RemoteDiskUsageService } from '../remote/remote-disk-usage.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal, computed, WritableSignal } from '@angular/core';
import { Subject } from 'rxjs';
import { provideTranslateService } from '@ngx-translate/core';
import { RemoteFeatures, VaultStatePayload, JobInfo } from '@app/types';
import { VaultService } from '../security/vault.service';
import { RemoteFacadeService } from './remote-facade.service';
import { JobManagementService } from '../operations/job-management.service';
import { MountManagementService } from '../operations/mount-management.service';
import { ServeManagementService } from '../operations/serve-management.service';
import { RemoteManagementService } from '../remote/remote-management.service';
import { RemoteFileOperationsService } from '../remote/remote-file-operations.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { FileSystemService } from '../operations/file-system.service';
import { NautilusService } from '../ui/nautilus.service';
import { BackendService } from '../infrastructure/system/backend.service';
import { UiStateService } from '../ui/state/ui-state.service';
import { PathService } from '../infrastructure/platform/path.service';
import { RcloneStatusService } from '../infrastructure/maintenance/rclone-status.service';
import { FlagConfigService } from '../remote/flag-config.service';
import { NotificationService } from '../ui/notification.service';
import { BackendTranslationService } from '../i18n/backend-translation.service';
import { QuickRunService } from '../flow/quick-run.service';
import { AutomationService } from '../operations/automation.service';
import { ModalService } from '../ui/modal.service';
import { SettingsChangeEvent } from '@app/types';

describe('RemoteFacadeService', () => {
  let service: RemoteFacadeService;

  let rcloneReady$: Subject<void>;
  let remoteCacheUpdated$: Subject<string | undefined>;
  let remoteSettingsChanged$: Subject<void>;
  let backendSwitched$: Subject<void>;
  let systemSettingsChanged$: Subject<SettingsChangeEvent>;
  let vaultState$: Subject<VaultStatePayload>;
  let isStatusKnown: WritableSignal<boolean>;
  let isVaultLocked: WritableSignal<boolean>;

  let mockRemoteService: {
    getAllRemoteConfigs: ReturnType<typeof vi.fn>;
    getRemoteTypes: ReturnType<typeof vi.fn>;
    clearCache: ReturnType<typeof vi.fn>;
    getFeaturesSignal: ReturnType<typeof vi.fn>;
  };
  let mockAppSettingsService: {
    getRemoteSettings: ReturnType<typeof vi.fn>;
    options: ReturnType<typeof vi.fn>;
    saveSetting: ReturnType<typeof vi.fn>;
    saveRemoteSettings: ReturnType<typeof vi.fn>;
  };
  let mockStatusService: {
    refreshStatus: ReturnType<typeof vi.fn>;
    rcloneStatus: ReturnType<typeof signal>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    rcloneReady$ = new Subject<void>();
    remoteCacheUpdated$ = new Subject<string | undefined>();
    remoteSettingsChanged$ = new Subject<void>();
    backendSwitched$ = new Subject<void>();
    systemSettingsChanged$ = new Subject<SettingsChangeEvent>();
    vaultState$ = new Subject<VaultStatePayload>();

    mockRemoteService = {
      getAllRemoteConfigs: vi.fn().mockResolvedValue({}),
      getRemoteTypes: vi.fn().mockResolvedValue({}),
      clearCache: vi.fn(),
      getFeaturesSignal: vi.fn().mockReturnValue(signal({})),
    };

    mockAppSettingsService = {
      getRemoteSettings: vi.fn().mockResolvedValue({}),
      options: vi.fn().mockReturnValue(null),
      saveSetting: vi.fn().mockResolvedValue(undefined),
      saveRemoteSettings: vi.fn().mockResolvedValue(undefined),
    };

    mockStatusService = {
      refreshStatus: vi.fn().mockResolvedValue(undefined),
      rcloneStatus: signal('inactive'),
    };

    isStatusKnown = signal(true);
    isVaultLocked = signal(false);

    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        RemoteFacadeService,
        { provide: ApiClientService, useValue: {} },
        {
          provide: VaultService,
          useValue: {
            isStatusKnown,
            isVaultLocked,
            isAccessible: computed(() => isStatusKnown() && !isVaultLocked()),
          },
        },
        {
          provide: JobManagementService,
          useValue: {
            jobs: signal([]),
            jobsByRemote: signal({}),
            refreshJobs: vi.fn().mockResolvedValue([]),
            getActiveJobsForRemote: vi.fn().mockReturnValue([]),
            stopJobsByGroup: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: MountManagementService,
          useValue: {
            mountedRemotes: signal([]),
            mountsByRemote: signal({}),
            getMountedRemotes: vi.fn().mockResolvedValue([]),
            unmountRemote: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: ServeManagementService,
          useValue: {
            runningServes: signal([]),
            servesByRemote: signal({}),
            refreshServes: vi.fn().mockResolvedValue([]),
          },
        },
        { provide: RemoteManagementService, useValue: mockRemoteService },
        {
          provide: RemoteFileOperationsService,
          useValue: {
            getDiskUsage: vi.fn().mockResolvedValue({ total: 1000, used: 200, free: 800 }),
            cleanup: vi.fn().mockResolvedValue(undefined),
          },
        },
        { provide: AppSettingsService, useValue: mockAppSettingsService },
        {
          provide: EventListenersService,
          useValue: {
            listenToRcloneEngineReady: (): Subject<void> => rcloneReady$,
            listenToRemoteCacheUpdated: (): Subject<string | undefined> => remoteCacheUpdated$,
            listenToRemoteSettingsChanged: (): Subject<void> => remoteSettingsChanged$,
            listenToBackendSwitched: (): Subject<void> => backendSwitched$,
            listenToSystemSettingsChanged: (): Subject<SettingsChangeEvent> =>
              systemSettingsChanged$,
            listenToVaultState: (): Subject<VaultStatePayload> => vaultState$,
          },
        },
        {
          provide: FileSystemService,
          useValue: { openInFiles: vi.fn().mockResolvedValue(undefined) },
        },
        {
          provide: NautilusService,
          useValue: {
            isStandaloneWindow: vi.fn().mockReturnValue(false),
            newNautilusWindow: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: BackendService,
          useValue: {
            activeBackend: signal('local'),
          },
        },
        {
          provide: UiStateService,
          useValue: {
            selectedRemote: signal(null),
          },
        },
        {
          provide: PathService,
          useValue: {
            setRemoteNames: vi.fn(),
            isLocalPath: vi.fn().mockReturnValue(true),
            getRemoteNameFromFs: (name: string): string => name.split(':')[0],
            normalizeRemoteForRclone: (name: string): string =>
              name.endsWith(':') ? name : `${name}:`,
          },
        },
        { provide: RcloneStatusService, useValue: mockStatusService },
        {
          provide: FlagConfigService,
          useValue: {
            loadAllFlagFields: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: NotificationService,
          useValue: {
            showSuccess: vi.fn(),
            showError: vi.fn(),
            confirmModal: vi.fn().mockResolvedValue(true),
            showInfo: vi.fn(),
          },
        },
        {
          provide: BackendTranslationService,
          useValue: {
            translateBackendMessage: vi.fn((m: unknown) => String(m)),
          },
        },
        {
          provide: QuickRunService,
          useValue: {
            refresh: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: AutomationService,
          useValue: {
            refreshAutomations: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: ModalService,
          useValue: {},
        },
      ],
    });

    service = TestBed.inject(RemoteFacadeService);
  });

  it('should initialize and call initial refreshAll', () => {
    TestBed.tick();
    expect(service).toBeTruthy();
    expect(mockRemoteService.getAllRemoteConfigs).toHaveBeenCalled();
  });

  it('defers startup until vault status is known and unlocked', async () => {
    mockRemoteService.getRemoteTypes.mockClear();
    mockRemoteService.getAllRemoteConfigs.mockClear();
    isStatusKnown.set(false);
    TestBed.tick();
    rcloneReady$.next();
    await service.refreshAll();
    expect(mockRemoteService.getRemoteTypes).not.toHaveBeenCalled();
    expect(mockRemoteService.getAllRemoteConfigs).not.toHaveBeenCalled();

    isVaultLocked.set(true);
    isStatusKnown.set(true);
    TestBed.tick();
    rcloneReady$.next();
    remoteCacheUpdated$.next(undefined);
    expect(mockRemoteService.getRemoteTypes).not.toHaveBeenCalled();
    expect(mockRemoteService.getAllRemoteConfigs).not.toHaveBeenCalled();

    isVaultLocked.set(false);
    TestBed.tick();
    await service.refreshAll();
    expect(mockRemoteService.getRemoteTypes).not.toHaveBeenCalled();
    expect(mockRemoteService.getAllRemoteConfigs).toHaveBeenCalled();
  });

  it('handles status loading failures during background refresh', async () => {
    const error = new Error('RPC unavailable');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockStatusService.refreshStatus.mockRejectedValue(error);
    try {
      await expect(service.refreshAll()).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith(
        '[RemoteFacadeService] Failed to refresh remote data:',
        error
      );
    } finally {
      log.mockRestore();
    }
  });

  it('should coalesce concurrent calls to loadRemotes and execute a trailing run', async () => {
    await service.refreshAll();
    mockRemoteService.getAllRemoteConfigs.mockClear();
    let resolveFirst: (v: Record<string, unknown>) => void = () => undefined;
    const firstCallPromise = new Promise<Record<string, unknown>>(r => {
      resolveFirst = r;
    });

    mockRemoteService.getAllRemoteConfigs
      .mockReturnValueOnce(firstCallPromise)
      .mockResolvedValueOnce({ myremote: { type: 'drive' } });

    // Trigger first load
    const p1 = service.loadRemotes();

    // Trigger second load while first is in-flight
    const p2 = service.loadRemotes();

    // Both should be promises
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();

    // Resolve first with empty
    resolveFirst({});
    await p1;

    // Await second (trailing) execution
    await p2;

    // Both configs calls should have run sequentially
    expect(mockRemoteService.getAllRemoteConfigs).toHaveBeenCalledTimes(2); // The active load and one trailing refresh
    expect(service.activeRemotes().map(r => r.name)).toContain('myremote');
  });

  it('should coalesce concurrent refreshAll calls and run trailing refresh', async () => {
    let resolveStatus: () => void = () => undefined;
    const statusDeferred = new Promise<void>(r => {
      resolveStatus = r;
    });

    mockStatusService.refreshStatus.mockReturnValueOnce(statusDeferred);

    // First refreshAll is in-flight
    const p1 = service.refreshAll();

    // Second refreshAll called while p1 is in-flight
    const p2 = service.refreshAll();

    expect(p1).toBeDefined();
    expect(p2).toBeDefined();

    // Finish first
    resolveStatus();
    await p1;
    await p2;

    // refreshStatus was called twice (initial + trailing)
    expect(mockStatusService.refreshStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('should correctly populate activeRemotes signal when new remotes are returned', async () => {
    mockRemoteService.getAllRemoteConfigs.mockResolvedValue({
      drive1: { type: 'drive' },
      s3remote: { type: 's3' },
    });

    await service.loadRemotes();

    const remotes = service.activeRemotes();
    expect(remotes.length).toBe(2);
    expect(remotes.map(r => r.name)).toEqual(['drive1', 's3remote']);
  });

  it('should reactively reload remotes when REMOTE_CACHE_CHANGED emits', async () => {
    mockRemoteService.getAllRemoteConfigs.mockResolvedValue({
      freshRemote: { type: 's3' },
    });

    remoteCacheUpdated$.next('system_refresh');

    // Wait for async execution
    await service.loadRemotes();

    expect(service.activeRemotes().map(r => r.name)).toContain('freshRemote');
  });

  it('should reactively trigger refreshAll when SYSTEM_SETTINGS_CHANGED emits wildcard', async () => {
    const refreshAllSpy = vi.spyOn(service, 'refreshAll').mockResolvedValue();

    systemSettingsChanged$.next({ category: '*', key: '*', value: null });

    expect(refreshAllSpy).toHaveBeenCalled();
  });

  it('publishes a large catalogue without evaluating status or requesting metadata', async () => {
    const configs = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [`remote-${i}`, { type: 'drive' }])
    );
    mockRemoteService.getAllRemoteConfigs.mockResolvedValue(configs);
    const disk = vi.spyOn(TestBed.inject(RemoteDiskUsageService), 'load').mockResolvedValue(null);
    await service.loadRemotes();
    expect(service.remoteSummaries()).toHaveLength(500);
    expect(service.remoteSummaries()[499]).toEqual({ name: 'remote-499', type: 'drive' });
    expect(mockRemoteService.getFeaturesSignal).not.toHaveBeenCalled();
    expect(disk).not.toHaveBeenCalled();
    expect(TestBed.inject(FlagConfigService).loadAllFlagFields).not.toHaveBeenCalled();
    expect(mockRemoteService.getRemoteTypes).not.toHaveBeenCalled();
    expect(service.loading()).toBe(false);
  });

  it('finishes list loading while unrelated status refresh is still pending', async () => {
    await service.refreshAll();
    let finish!: () => void;
    mockStatusService.refreshStatus.mockReturnValueOnce(
      new Promise<void>(r => {
        finish = r;
      })
    );
    mockRemoteService.getAllRemoteConfigs.mockResolvedValue({ ready: { type: 's3' } });
    const refresh = service.refreshAll();
    await vi.waitFor(() =>
      expect(service.remoteSummaries()).toEqual([{ name: 'ready', type: 's3' }])
    );
    expect(service.loading()).toBe(false);
    finish();
    await refresh;
  });

  it('does not rebuild profiles on disk or feature updates, or unchanged reloads', async () => {
    const features = signal({ loading: true } as RemoteFeatures);
    mockRemoteService.getFeaturesSignal.mockReturnValue(features);
    mockRemoteService.getAllRemoteConfigs.mockResolvedValue({ drive: { type: 'drive' } });
    await service.loadRemotes();
    const initial = service.getRemote('drive');
    await TestBed.inject(RemoteDiskUsageService).load('drive');
    const afterDisk = service.getRemote('drive');
    expect(afterDisk?.status.diskUsage.total).toBe(1000);
    expect(afterDisk?.status.mount).toBe(initial?.status.mount);
    expect(afterDisk?.status.sync).toBe(initial?.status.sync);
    features.set({ loading: false, About: true } as RemoteFeatures);
    const afterFeatures = service.getRemote('drive');
    expect(afterFeatures?.features.About).toBe(true);
    expect(afterFeatures?.status.mount).toBe(initial?.status.mount);
    await service.loadRemotes();
    expect(service.getRemote('drive')).toBe(afterFeatures);
    expect(mockRemoteService.clearCache).not.toHaveBeenCalled();
  });

  it('updates only the remote whose profile settings changed', async () => {
    mockRemoteService.getAllRemoteConfigs.mockResolvedValue({
      a: { type: 's3' },
      b: { type: 'drive' },
    });
    await service.loadRemotes();
    const [a, b] = service.activeRemotes();
    mockAppSettingsService.getRemoteSettings.mockResolvedValue({
      a: { primaryActions: ['mount'] },
    });
    await service.loadRemotes();
    const [nextA, nextB] = service.activeRemotes();
    expect(nextA.primaryActions).toEqual(['mount']);
    expect(nextA).not.toBe(a);
    expect(nextB).toBe(b);
  });

  it('keeps unrelated remote status stable when polling updates another remote', async () => {
    mockRemoteService.getAllRemoteConfigs.mockResolvedValue({
      a: { type: 'drive' },
      b: { type: 's3' },
    });
    await service.loadRemotes();
    const b = service.getRemote('b');
    const jobs = TestBed.inject(JobManagementService).jobsByRemote as WritableSignal<
      Record<string, JobInfo[]>
    >;
    jobs.set({ a: [{ jobid: 1, job_type: 'copy', status: 'Running' }] as JobInfo[] });
    expect(service.getRemote('b')).toBe(b);
    expect(service.getRemote('a')?.status.copy.active).toBe(true);
    jobs.set({ a: [{ jobid: 1, job_type: 'copy', status: 'Completed' }] as JobInfo[] });
    expect(service.getRemote('a')?.status.copy.active).toBe(false);
    expect(service.getRemote('b')).toBe(b);
  });

  it('refreshes the type and feature cache when a remote configuration changes', async () => {
    mockRemoteService.getAllRemoteConfigs.mockResolvedValue({ drive: { type: 'drive' } });
    await service.loadRemotes();
    mockRemoteService.getAllRemoteConfigs.mockResolvedValue({ drive: { type: 's3' } });
    await service.loadRemotes();
    expect(service.remoteSummaries()).toEqual([{ name: 'drive', type: 's3' }]);
    expect(service.getRemote('drive')?.type).toBe('s3');
    expect(mockRemoteService.clearCache).toHaveBeenCalledWith('drive');
  });

  it('keeps remote lookup and ordering independent of unrelated feature signals', async () => {
    mockRemoteService.getAllRemoteConfigs.mockResolvedValue({
      a: { type: 's3' },
      b: { type: 'drive' },
    });
    mockAppSettingsService.options.mockReturnValue({
      'runtime.remote_layouts': { value: { local: { order: ['missing', 'b'], hidden: ['a'] } } },
    });
    await service.loadRemotes();
    expect(service.remoteSummaries().map(r => r.name)).toEqual(['b', 'a']);
    expect(service.getRemote('b')?.name).toBe('b');
    expect(mockRemoteService.getFeaturesSignal).toHaveBeenCalledTimes(1);
    expect(service.isRemoteActive('a:')).toBe(true);
    expect(service.getRemote(null)).toBeUndefined();
    expect(service.getRemote('missing')).toBeUndefined();
    expect(service.orderedVisibleRemotes().map(r => r.name)).toEqual(['b']);
  });

  it('preserves configured profiles, latest jobs and scope exclusions', async () => {
    mockRemoteService.getAllRemoteConfigs.mockResolvedValue({ drive: { type: 'drive' } });
    mockAppSettingsService.getRemoteSettings.mockResolvedValue({
      drive: { syncConfigs: { photos: { source: 'drive:photos', dest: '/tmp/photos' } } },
    });
    const jobs = TestBed.inject(JobManagementService).jobsByRemote as WritableSignal<
      Record<string, JobInfo[]>
    >;
    jobs.set({
      drive: [
        { jobid: 3, job_type: 'sync', status: 'Completed', profile: 'photos' },
        { jobid: 9, job_type: 'sync', status: 'Completed', profile: 'photos' },
        { jobid: 20, job_type: 'sync', status: 'Running', profile: 'photos', origin: 'quickrun' },
      ] as JobInfo[],
    });
    await service.loadRemotes();
    const status = service.getRemote('drive')?.status.sync;
    expect(status?.active).toBe(false);
    expect(status?.jobId).toBe(9);
    expect(status?.configuredProfiles).toEqual(['photos']);
    expect(status?.lastRunProfiles).toEqual({ photos: 9 });
  });

  it('rejects an old catalogue response after a backend switch', async () => {
    await service.refreshAll();
    let finish!: (value: Record<string, unknown>) => void;
    mockRemoteService.getAllRemoteConfigs
      .mockReturnValueOnce(
        new Promise(r => {
          finish = r;
        })
      )
      .mockResolvedValue({ current: { type: 's3' } });
    const old = service.loadRemotes();
    backendSwitched$.next();
    finish({ stale: { type: 'drive' } });
    await old;
    await vi.waitFor(() => expect(service.remoteSummaries().map(r => r.name)).toEqual(['current']));
  });
  it('uses the catalogue key as identity and does not let old clone settings overwrite it', async () => {
    mockRemoteService.getAllRemoteConfigs.mockResolvedValue({
      drive: { name: 'wrong', type: 's3' },
    });
    mockAppSettingsService.getRemoteSettings.mockResolvedValue({
      drive: {
        name: 'old',
        config: { name: 'old', type: 'drive' },
        primaryActions: ['mount'],
      },
    });
    await service.loadRemotes();
    expect(service.getRemote('drive:')?.config).toEqual({ name: 'drive', type: 's3' });
    const cloned = await service.cloneRemote('drive');
    expect(cloned?.['name']).toBe('drive-clone');
    expect(cloned?.['config']).toEqual({ name: 'drive-clone', type: 's3' });
    expect(cloned?.['primaryActions']).toEqual(['mount']);
  });

  it('deduplicates saved ordering and changes visibility without evaluating remote status', async () => {
    mockRemoteService.getAllRemoteConfigs.mockResolvedValue({
      a: { type: 's3' },
      b: { type: 'drive' },
    });
    mockAppSettingsService.options.mockReturnValue({
      'runtime.remote_layouts': { value: { local: { order: ['b', 'b', 'missing'], hidden: [] } } },
    });
    await service.loadRemotes();
    expect(service.remoteSummaries().map(r => r.name)).toEqual(['b', 'a']);
    await service.toggleRemoteVisibility('local', 'a');
    expect(mockRemoteService.getFeaturesSignal).not.toHaveBeenCalled();
    expect(mockAppSettingsService.saveSetting).toHaveBeenLastCalledWith(
      'runtime',
      'remote_layouts',
      {
        local: { order: ['b', 'a'], hidden: ['a'] },
      }
    );
  });
  it('keeps identical concurrent actions separate and removes completed entries', async () => {
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const first = service.executeAction(
      'drive',
      'mount',
      () =>
        new Promise<void>(resolve => {
          finishFirst = resolve;
        }),
      'main'
    );
    const second = service.executeAction(
      'drive',
      'mount',
      () =>
        new Promise<void>(resolve => {
          finishSecond = resolve;
        }),
      'main'
    );
    expect(service.actionInProgress()['drive']).toHaveLength(2);
    finishFirst();
    await first;
    expect(service.actionInProgress()['drive']).toHaveLength(1);
    finishSecond();
    await second;
    expect(service.actionInProgress()).toEqual({});
  });

  it('does not let an old backend action clear a new backend action', async () => {
    let finishOld!: () => void;
    let finishNew!: () => void;
    const old = service.executeAction(
      'drive',
      'mount',
      () =>
        new Promise<void>(resolve => {
          finishOld = resolve;
        }),
      'main'
    );
    backendSwitched$.next();
    expect(service.actionInProgress()).toEqual({});
    const current = service.executeAction(
      'drive',
      'mount',
      () =>
        new Promise<void>(resolve => {
          finishNew = resolve;
        }),
      'main'
    );
    finishOld();
    await old;
    expect(service.actionInProgress()['drive']).toHaveLength(1);
    finishNew();
    await current;
    expect(service.actionInProgress()).toEqual({});
  });

  it('stops the actual execution groups for a profile without touching quick runs', async () => {
    const jobs = TestBed.inject(JobManagementService);
    vi.mocked(jobs.getActiveJobsForRemote).mockReturnValue([
      { job_type: 'sync', group: 'sync/drive/daily_first' },
      { job_type: 'sync', group: 'sync/drive/daily_second' },
      { job_type: 'sync', group: 'sync/drive/daily_second' },
      { job_type: 'sync', group: 'quick-run', origin: 'quickrun' },
      { job_type: 'copy', group: 'other-operation' },
    ] as JobInfo[]);
    await service.stopJob('drive', 'sync', undefined, 'daily');
    expect(jobs.getActiveJobsForRemote).toHaveBeenCalledWith('drive', 'daily');
    expect(jobs.stopJobsByGroup).toHaveBeenCalledTimes(2);
    expect(jobs.stopJobsByGroup).toHaveBeenCalledWith('sync/drive/daily_first');
    expect(jobs.stopJobsByGroup).toHaveBeenCalledWith('sync/drive/daily_second');
  });

  it('does not unmount another profile when the requested profile is missing', async () => {
    const mounts = TestBed.inject(MountManagementService).mountedRemotes as WritableSignal<
      import('@app/types').MountedRemote[]
    >;
    mounts.set([{ fs: 'drive:', mount_point: '/tmp/other', profile: 'other' }]);
    await expect(service.stopJob('drive', 'mount', undefined, 'missing')).rejects.toThrow(
      'Active mount not found'
    );
    expect(TestBed.inject(MountManagementService).unmountRemote).not.toHaveBeenCalled();
    expect(service.actionInProgress()).toEqual({});
  });

  it('loads the new backend without waiting for old settings that never resolve', async () => {
    await service.refreshAll();
    mockAppSettingsService.getRemoteSettings
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValue({});
    mockRemoteService.getAllRemoteConfigs
      .mockResolvedValueOnce({ old: { type: 'drive' } })
      .mockResolvedValue({ current: { type: 's3' } });
    const old = service.loadRemotes();
    backendSwitched$.next();
    await service.loadRemotes();
    await old;
    expect(service.remoteSummaries()).toEqual([{ name: 'current', type: 's3' }]);
    expect(service.loading()).toBe(false);
  });
  it('does not clean up a different backend after confirmation was opened', async () => {
    let confirm!: (value: boolean) => void;
    vi.mocked(TestBed.inject(NotificationService).confirmModal).mockReturnValueOnce(
      new Promise(resolve => {
        confirm = resolve;
      })
    );
    const cleanup = service.emptyTrash({ name: 'drive' });
    backendSwitched$.next();
    confirm(true);
    expect(await cleanup).toBe(false);
    expect(TestBed.inject(RemoteFileOperationsService).cleanup).not.toHaveBeenCalled();
  });

  it('opens the requested profile using the canonical nested rclone fields', async () => {
    mockRemoteService.getAllRemoteConfigs.mockResolvedValue({ drive: { type: 'drive' } });
    mockAppSettingsService.getRemoteSettings.mockResolvedValue({
      drive: {
        mountConfigs: {
          first: { rclone: { mountPoint: '/tmp/first' } },
          selected: { rclone: { mountPoint: '/tmp/selected' } },
        },
      },
    });
    await service.loadRemotes();
    await service.openRemoteInFiles('drive', 'mount', 'selected');
    expect(TestBed.inject(FileSystemService).openInFiles).toHaveBeenCalledWith('/tmp/selected');
  });
});
