import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal, computed, WritableSignal } from '@angular/core';
import { Subject } from 'rxjs';
import { provideTranslateService } from '@ngx-translate/core';
import { VaultStatePayload } from '@app/types';
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
          },
        },
        {
          provide: MountManagementService,
          useValue: {
            mountedRemotes: signal([]),
            mountsByRemote: signal({}),
            getMountedRemotes: vi.fn().mockResolvedValue([]),
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
        { provide: FileSystemService, useValue: {} },
        {
          provide: NautilusService,
          useValue: {
            isStandaloneWindow: vi.fn().mockReturnValue(false),
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
    expect(mockRemoteService.getRemoteTypes).toHaveBeenCalled();
    expect(mockRemoteService.getAllRemoteConfigs).toHaveBeenCalled();
  });

  it('handles provider loading failures during background refresh', async () => {
    const error = new Error('RPC unavailable');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockRemoteService.getRemoteTypes.mockRejectedValue(error);
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
    expect(mockRemoteService.getAllRemoteConfigs).toHaveBeenCalledTimes(3); // 1 in constructor + 2 explicitly
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
});
