import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslateService } from '@ngx-translate/core';
import {
  BackendUpdateStatus,
  DownloadStateStatus,
  DownloadStatus,
  UpdateInfo,
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

  beforeEach(() => {
    TestBed.resetTestingModule();
    changed = new Subject();
    ready = new Subject();
    found = new Subject();
    progress = new Subject();
    info = { ...available, status: BackendUpdateStatus.Downloading, download };
    invoke.mockReset().mockImplementation(async (command: string) => {
      if (command === 'get_rclone_update_info') return info;
      if (command === 'is_librclone') return false;
      if (command === 'can_auto_install') return true;
      if (command === 'get_build_type') return 'portable';
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
    let resolve!: (info: UpdateInfo | null) => void;
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
    resolve({ ...available, status: BackendUpdateStatus.Downloading });
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

  it('does not restore a separate updater for librclone', async () => {
    invoke.mockImplementation(async (command: string) => command === 'is_librclone');
    await service.initialize();
    expect(service.isUpdaterEnabled()).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith('get_rclone_update_info', undefined);
  });
});
