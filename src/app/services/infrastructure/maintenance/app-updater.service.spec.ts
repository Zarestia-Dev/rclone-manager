import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslateService } from '@ngx-translate/core';
import {
  BackendUpdateStatus,
  DownloadStateStatus,
  DownloadStatus,
  UpdateInfo,
  UpdatePolicy,
  UpdaterStateChanged,
} from '@app/types';
import { AppUpdaterService } from './app-updater.service';
import { EventListenersService } from '../system/event-listeners.service';
import { ApiClientService } from '../platform/api-client.service';
import { SseClientService } from '../platform/sse-client.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { NotificationService } from '../../ui/notification.service';
import { BackendTranslationService } from '../../i18n/backend-translation.service';

const available: UpdateInfo = {
  version: '1.2.0',
  currentVersion: '1.1.0',
  updateAvailable: true,
  status: BackendUpdateStatus.Available,
};
const download: DownloadStatus = {
  downloadedBytes: 42,
  totalBytes: 100,
  percentage: 42,
  state: { status: DownloadStateStatus.InProgress },
};

describe('AppUpdaterService state restoration', () => {
  let service: AppUpdaterService;
  let info: UpdateInfo | null;
  let policy: UpdatePolicy;
  let changed: Subject<UpdaterStateChanged>;
  let ready: Subject<void>;
  let found: Subject<UpdateInfo>;
  let progress: Subject<DownloadStatus>;
  const invoke = vi.fn();
  const saveSetting = vi.fn();
  const showError = vi.fn();

  beforeEach(() => {
    TestBed.resetTestingModule();
    changed = new Subject();
    ready = new Subject();
    found = new Subject();
    progress = new Subject();
    info = { ...available, status: BackendUpdateStatus.Downloading, download };
    policy = { installation: 'portable', method: 'binary', canInstall: true };
    invoke.mockReset().mockImplementation(async (command: string) => {
      if (command === 'get_app_update_info' || command === 'fetch_update') return info;
      if (command === 'is_librclone') return false;
      if (command === 'get_update_policy') return policy;
      return null;
    });
    showError.mockReset();
    saveSetting.mockReset().mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiClientService, useValue: { invoke } },
        { provide: SseClientService, useValue: {} },
        {
          provide: NotificationService,
          useValue: {
            showError,
            showInfo: vi.fn(),
            showSuccess: vi.fn(),
            showWarning: vi.fn(),
            confirmModal: vi.fn().mockResolvedValue(true),
          },
        },
        { provide: TranslateService, useValue: { instant: (key: string): string => key } },
        { provide: BackendTranslationService, useValue: { translateBackendMessage: String } },
        {
          provide: AppSettingsService,
          useValue: {
            getSettingValue: vi.fn(async (key: string) =>
              key.endsWith('auto_check_updates')
                ? false
                : key.endsWith('skipped_updates')
                  ? ['1.2.0']
                  : 'stable'
            ),
            saveSetting,
          },
        },
        {
          provide: EventListenersService,
          useValue: {
            listenToUpdaterStateChanged: (): Subject<UpdaterStateChanged> => changed,
            listenToRcloneEngineReady: (): Subject<void> => ready,
            listenToEngineRestarted: (): Subject<void> => ready,
            listenToAppUpdateFound: (): Subject<UpdateInfo> => found,
            listenToRcloneUpdateFound: (): Subject<UpdateInfo> => found,
            listenToAppDownloadProgress: (): Subject<DownloadStatus> => progress,
          },
        },
      ],
    });
    service = TestBed.inject(AppUpdaterService);
  });

  it('confirms a rendered native frontend without waiting for vault unlock or updater settings', async () => {
    Object.defineProperty(service, 'isTauri', { value: true });
    await service.confirmStartup();
    expect(invoke).toHaveBeenCalledWith('confirm_app_update_startup', undefined);
    expect(invoke).not.toHaveBeenCalledWith('get_update_policy', undefined);
  });

  it('does not use browser sessions to confirm server startup', async () => {
    Object.defineProperty(service, 'isTauri', { value: false });
    await service.confirmStartup();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('handles a missing native startup command without rejecting frontend startup', async () => {
    Object.defineProperty(service, 'isTauri', { value: true });
    invoke.mockRejectedValueOnce(new Error('IPC unavailable'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(service.confirmStartup()).resolves.toBeUndefined();
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('restores an active download with auto-check disabled and a skipped release', async () => {
    await service.initialize();
    expect(service.autoCheckEnabled()).toBe(false);
    expect(service.updateInProgress()).toBe(true);
    expect(service.updateAvailable()?.version).toBe('1.2.0');
    expect(invoke).not.toHaveBeenCalledWith('fetch_update', expect.anything());
  });

  it('restores a staged update after reload', async () => {
    info = { ...available, status: BackendUpdateStatus.ReadyToRestart, updateAvailable: false };
    await service.initialize();
    expect(service.readyToRestart()).toBe(true);
    expect(service.updateAvailable()).not.toBeNull();
    expect(service.updateInProgress()).toBe(false);
  });

  it('restores installation in progress even when availability is false', async () => {
    info = { ...available, status: BackendUpdateStatus.Installing, updateAvailable: false };
    await service.initialize();
    expect(service.updateInProgress()).toBe(true);
    expect(service.updateAvailable()).not.toBeNull();
  });

  it('follows completion and clearing from another window', async () => {
    await service.initialize();
    info = { ...available, status: BackendUpdateStatus.ReadyToRestart };
    changed.next({ target: 'app' });
    await Promise.resolve();
    expect(service.readyToRestart()).toBe(true);
    info = null;
    changed.next({ target: 'app' });
    await Promise.resolve();
    expect(service.readyToRestart()).toBe(false);
    expect(service.hasUpdates()).toBe(false);
  });

  it('resynchronizes when the headless event connection returns', async () => {
    await service.initialize();
    info = { ...available, status: BackendUpdateStatus.ReadyToRestart };
    ready.next();
    await Promise.resolve();
    expect(service.readyToRestart()).toBe(true);
  });

  it('ignores an older snapshot that arrives after a newer state notification', async () => {
    await service.initialize();
    let resolve!: (info: UpdateInfo | null) => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done;
        })
    );
    changed.next({ target: 'app' });
    info = { ...available, status: BackendUpdateStatus.ReadyToRestart };
    changed.next({ target: 'app' });
    await Promise.resolve();
    resolve({ ...available, status: BackendUpdateStatus.Downloading });
    await Promise.resolve();
    expect(service.readyToRestart()).toBe(true);
  });

  it('keeps the active state when a status request fails', async () => {
    await service.initialize();
    invoke.mockRejectedValueOnce(new Error('offline'));
    changed.next({ target: 'app' });
    await Promise.resolve();
    expect(service.updateInProgress()).toBe(true);
  });

  it('does not change channel or start a second download while busy', async () => {
    await service.initialize();
    invoke.mockClear();
    await service.setChannel('beta');
    await service.installUpdate();
    expect(saveSetting).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not stay checking when the check button is pressed twice', async () => {
    info = null;
    await service.initialize();
    let resolve!: (info: UpdateInfo | null) => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done;
        })
    );
    const first = service.checkForUpdates();
    await service.checkForUpdates();
    resolve(available);
    await first;
    expect(service.isChecking()).toBe(false);
  });

  it('keeps a manual check active across snapshots and reports its failure', async () => {
    info = null;
    await service.initialize();
    let reject!: (error: Error) => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        })
    );
    const check = service.checkForUpdates();
    changed.next({ target: 'app' });
    await Promise.resolve();
    expect(service.isChecking()).toBe(true);
    await service.checkForUpdates();
    expect(invoke.mock.calls.filter(([command]) => command === 'fetch_update')).toHaveLength(1);

    reject(new Error('Invalid update manifest'));
    await check;
    expect(showError).toHaveBeenCalledWith('updates.checkFailed');
    expect(service.isChecking()).toBe(false);
  });

  it('keeps a manual check active when an update-found event arrives before its response', async () => {
    info = null;
    await service.initialize();
    let resolve!: (value: UpdateInfo) => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done;
        })
    );
    const check = service.checkForUpdates();
    found.next({ ...available, version: '1.3.0' });
    expect(service.isChecking()).toBe(true);
    resolve(available);
    await check;
    expect(service.updateAvailable()?.version).toBe('1.3.0');
    expect(service.isChecking()).toBe(false);
  });

  it('restores byte counts and continues live progress without restarting the download', async () => {
    await service.initialize();
    expect(service.downloadStatus()).toEqual(download);
    progress.next({ ...download, downloadedBytes: 60, percentage: 60 });
    expect(service.downloadStatus().percentage).toBe(60);
    expect(service.updateInProgress()).toBe(true);
  });

  it('restores state even if capability detection fails', async () => {
    const normal = invoke.getMockImplementation();
    if (!normal) throw new Error('Missing invoke mock');
    invoke.mockImplementation((command: string) =>
      command === 'get_update_policy' ? Promise.reject(new Error('unavailable')) : normal(command)
    );
    await service.initialize();
    expect(service.updateInProgress()).toBe(true);
    expect(service.downloadStatus()).toEqual(download);
  });

  it('reads cancellation from the backend instead of assuming it succeeded', async () => {
    await service.initialize();
    const normal = invoke.getMockImplementation();
    if (!normal) throw new Error('Missing invoke mock');
    invoke.mockImplementation((command: string) => {
      if (command === 'cancel_app_update') info = { ...available };
      return normal(command);
    });
    await service.cancelUpdate();
    expect(service.updateInProgress()).toBe(false);
    expect(service.downloadStatus().downloadedBytes).toBe(0);
  });

  it('keeps installation disabled until backend policy has loaded', async () => {
    expect(service.canAutoInstall()).toBe(false);
    await service.initialize();
    expect(service.canAutoInstall()).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith('get_build_type', undefined);
    expect(invoke).not.toHaveBeenCalledWith('can_auto_install', undefined);
  });

  it('recovers eligibility and clears the old reason when a fresh policy permits installation', async () => {
    info = { ...available };
    policy = { ...policy, canInstall: false, reason: 'not writable' };
    await service.initialize();
    expect(service.canAutoInstall()).toBe(false);
    expect(service.installationReason()).toBe('not writable');

    info = { ...available, installation: { ...policy, canInstall: true, reason: null } };
    await service.checkForUpdates();
    expect(service.canAutoInstall()).toBe(true);
    expect(service.installationReason()).toBe('');
  });

  it('accepts a fresh snapshot after the initial policy request failed', async () => {
    const normal = invoke.getMockImplementation();
    if (!normal) throw new Error('Missing invoke mock');
    invoke.mockImplementation((command: string) =>
      command === 'get_update_policy' ? Promise.reject(new Error('unavailable')) : normal(command)
    );
    await service.initialize();
    expect(service.canAutoInstall()).toBe(false);
    info = { ...available, installation: policy };
    changed.next({ target: 'app' });
    await Promise.resolve();
    expect(service.canAutoInstall()).toBe(true);
    expect(service.buildType()).toBe('portable');
  });

  it('keeps snapshot restrictions authoritative when the general policy permits installation', async () => {
    info = {
      ...available,
      installation: { ...policy, canInstall: false, reason: 'missing artifact' },
    };
    await service.initialize();
    expect(service.canAutoInstall()).toBe(false);
    expect(service.installationReason()).toBe('missing artifact');
  });

  it.each(['native', 'android', 'appimage', 'server', 'unknown'] as const)(
    'keeps the legacy build badge hidden for %s installations',
    async installation => {
      policy = { ...policy, installation };
      await service.initialize();
      expect(service.buildType()).toBeNull();
    }
  );

  it('uses the latest snapshot for installation identity as well as eligibility', async () => {
    info = {
      ...available,
      installation: { installation: 'pacman', method: 'unavailable', canInstall: false },
    };
    await service.initialize();
    expect(service.buildType()).toBe('pacman');
    expect(service.canAutoInstall()).toBe(false);

    info = {
      ...available,
      installation: { installation: 'snap', method: 'unavailable', canInstall: false },
    };
    changed.next({ target: 'app' });
    await Promise.resolve();
    expect(service.buildType()).toBe('snap');
  });

  it('discards a staged APK and allows changing channel after backend confirmation', async () => {
    info = { ...available, status: BackendUpdateStatus.ReadyToRestart };
    await service.initialize();
    const normal = invoke.getMockImplementation();
    if (!normal) throw new Error('Missing invoke mock');
    invoke.mockImplementation((command: string) => {
      if (command === 'cancel_app_update') info = { ...available };
      return normal(command);
    });
    await service.cancelUpdate();
    expect(invoke).toHaveBeenCalledWith('cancel_app_update', undefined);
    expect(service.readyToRestart()).toBe(false);
    await service.setChannel('beta');
    expect(saveSetting).toHaveBeenCalledWith('runtime', 'app_update_channel', 'beta');
  });

  it('keeps a staged update when the backend rejects discarding it', async () => {
    info = { ...available, status: BackendUpdateStatus.ReadyToRestart };
    await service.initialize();
    invoke.mockRejectedValueOnce(new Error('unavailable'));
    await service.cancelUpdate();
    expect(service.readyToRestart()).toBe(true);
    expect(service.isCancelling()).toBe(false);
  });

  it('does not offer installation when the release has no matching signed artifact', async () => {
    info = {
      ...available,
      installation: {
        installation: 'portable',
        method: 'binary',
        canInstall: false,
        reason: 'missing artifact',
      },
    };
    await service.initialize();
    expect(service.canAutoInstall()).toBe(false);
    expect(service.installationReason()).toBe('missing artifact');
    invoke.mockClear();
    await service.installUpdate();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails closed when backend policy detection fails', async () => {
    const normal = invoke.getMockImplementation();
    if (!normal) throw new Error('Missing invoke mock');
    invoke.mockImplementation((command: string) =>
      command === 'get_update_policy' ? Promise.reject(new Error('unavailable')) : normal(command)
    );
    await service.initialize();
    expect(service.canAutoInstall()).toBe(false);
    expect(service.updateInProgress()).toBe(true);
  });

  it('keeps installation failures visible and the verified payload retryable', async () => {
    info = {
      ...available,
      status: BackendUpdateStatus.ReadyToRestart,
      download: {
        ...download,
        state: { status: DownloadStateStatus.Failed, data: 'authorization declined' },
      },
    };
    await service.initialize();
    expect(service.readyToRestart()).toBe(true);
    expect(service.installationFailure()).toBe('authorization declined');
  });

  it('restores installation in progress and prevents duplicate downloads or channel changes', async () => {
    info = { ...available, status: BackendUpdateStatus.Installing };
    await service.initialize();
    expect(service.updateInProgress()).toBe(true);
    invoke.mockClear();
    await service.installUpdate();
    await service.cancelUpdate();
    await service.setChannel('beta');
    expect(invoke).not.toHaveBeenCalled();
    expect(saveSetting).not.toHaveBeenCalled();
  });
});
