import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslateService } from '@ngx-translate/core';
import {
  BackendUpdateStatus,
  DownloadStateStatus,
  DownloadStatus,
  UpdateInfo,
  UpdaterSnapshot,
  UpdaterStateChanged,
} from '@app/types';
import { RcloneUpdateService } from './rclone-update.service';
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

describe('RcloneUpdateService state restoration', () => {
  let service: RcloneUpdateService;
  let info: UpdateInfo | null;
  let changed: Subject<UpdaterStateChanged>;
  let ready: Subject<void>;
  let found: Subject<UpdateInfo>;
  let progress: Subject<DownloadStatus>;
  const invoke = vi.fn();
  const saveSetting = vi.fn();
  const showError = vi.fn();
  const showWarning = vi.fn();
  const translate = vi.fn((message: unknown) => String(message));

  beforeEach(() => {
    TestBed.resetTestingModule();
    changed = new Subject();
    ready = new Subject();
    found = new Subject();
    progress = new Subject();
    info = { ...available, status: BackendUpdateStatus.Downloading, download };
    invoke.mockReset().mockImplementation(async (command: string) => {
      if (command === 'get_rclone_update_info') return { update: info, checking: false };
      if (command === 'is_librclone') return false;
      return null;
    });
    showError.mockReset();
    showWarning.mockReset();
    translate.mockClear();
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
            showWarning,
            confirmModal: vi.fn().mockResolvedValue(true),
          },
        },
        { provide: TranslateService, useValue: { instant: (key: string): string => key } },
        { provide: BackendTranslationService, useValue: { translateBackendMessage: translate } },
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
    service = TestBed.inject(RcloneUpdateService);
  });

  it('restores an active download with auto-check disabled and a skipped release', async () => {
    await service.initialize();
    expect(service.autoCheckEnabled()).toBe(false);
    expect(service.downloading()).toBe(true);
    expect(service.updateAvailable()?.version).toBe('1.2.0');
    expect(invoke).not.toHaveBeenCalledWith('check_rclone_update', expect.anything());
  });

  it('restores a staged update after reload', async () => {
    info = { ...available, status: BackendUpdateStatus.ReadyToRestart, updateAvailable: false };
    await service.initialize();
    expect(service.readyToRestart()).toBe(true);
    expect(service.updateAvailable()).not.toBeNull();
    expect(service.downloading()).toBe(false);
  });

  it('follows completion and clearing from another window', async () => {
    await service.initialize();
    info = { ...available, status: BackendUpdateStatus.ReadyToRestart };
    changed.next({ target: 'rclone' });
    await Promise.resolve();
    expect(service.readyToRestart()).toBe(true);
    info = null;
    changed.next({ target: 'rclone' });
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
    let resolve!: (snapshot: UpdaterSnapshot) => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done;
        })
    );
    changed.next({ target: 'rclone' });
    info = { ...available, status: BackendUpdateStatus.ReadyToRestart };
    changed.next({ target: 'rclone' });
    await Promise.resolve();
    resolve({
      update: { ...available, status: BackendUpdateStatus.Downloading },
      checking: false,
    });
    await Promise.resolve();
    expect(service.readyToRestart()).toBe(true);
  });

  it('keeps the active state when a status request fails', async () => {
    await service.initialize();
    invoke.mockRejectedValueOnce(new Error('offline'));
    changed.next({ target: 'rclone' });
    await Promise.resolve();
    expect(service.downloading()).toBe(true);
  });

  it('does not change channel or start a second download while busy', async () => {
    await service.initialize();
    invoke.mockClear();
    await service.setChannel('beta');
    await service.performUpdate();
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

  it('preserves a staged update when apply fails and does not wait on a leaked event subscription', async () => {
    info = { ...available, status: BackendUpdateStatus.ReadyToRestart };
    await service.initialize();
    invoke.mockRejectedValueOnce(new Error('apply failed'));
    expect(await service.applyUpdate()).toBe(false);
    expect(service.readyToRestart()).toBe(true);
  });

  it('clears downloading when the worker reports failure after a reload', async () => {
    await service.initialize();
    info = available;
    changed.next({ target: 'rclone' });
    await Promise.resolve();
    expect(service.downloading()).toBe(false);
    expect(service.readyToRestart()).toBe(false);
  });

  it('translates the backend message of an update that did not run', async () => {
    info = null;
    await service.initialize();
    const message = '{"key":"backendErrors.rclone.noUpdateAvailable"}';
    invoke.mockResolvedValueOnce({ success: false, message, manual: false });
    translate.mockReturnValueOnce('No update available');
    expect(await service.performUpdate()).toBe(false);
    expect(translate).toHaveBeenCalledWith(message);
    expect(showWarning).toHaveBeenCalledWith('No update available');
  });

  it('shows what the backend recorded, also after a reload or from a scheduled check', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'is_librclone') return false;
      if (command === 'get_rclone_update_info') {
        return {
          update: null,
          checking: true,
          lastCheckedAt: '2026-11-05T10:00:00Z',
          error: 'backendErrors.updater.githubRateLimit',
          notice: 'backendSuccess.rclone.remoteRestartRequired',
        } satisfies UpdaterSnapshot;
      }
      return null;
    });
    await service.initialize();
    expect(service.isChecking()).toBe(true);
    expect(service.lastCheckedAt()).toBe('2026-11-05T10:00:00Z');
    expect(service.error()).toBe('backendErrors.updater.githubRateLimit');
    expect(service.notice()).toBe('backendSuccess.rclone.remoteRestartRequired');
  });

  it('shows a failed check from the snapshot even when its own response arrives late', async () => {
    info = null;
    await service.initialize();
    invoke.mockImplementation(async (command: string) => {
      if (command === 'check_rclone_update') {
        // The backend announces its new state before the command returns.
        changed.next({ target: 'rclone' });
        throw new Error('rate limited');
      }
      if (command === 'get_rclone_update_info') {
        return { update: null, checking: false, error: 'backendErrors.updater.github' };
      }
      return null;
    });
    await service.checkForUpdates();
    expect(service.error()).toBe('backendErrors.updater.github');
    expect(service.isChecking()).toBe(false);
  });

  it('does not restore a separate updater for librclone', async () => {
    invoke.mockImplementation(async (command: string) => command === 'is_librclone');
    await service.initialize();
    expect(service.isUpdaterEnabled()).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith('get_rclone_update_info', undefined);
  });
});
