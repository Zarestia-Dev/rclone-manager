import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BandwidthLimitResponse,
  DEFAULT_JOB_STATS,
  SystemStatusPayload,
  VaultStatePayload,
} from '@app/types';
import { VaultService } from '../../security/vault.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { BackendService } from '../system/backend.service';
import { EventListenersService } from '../system/event-listeners.service';
import { SystemInfoService } from '../system/system-info.service';
import { RcloneStatusService } from './rclone-status.service';

describe('RcloneStatusService status refresh', () => {
  let service: RcloneStatusService;
  let accessible: ReturnType<typeof signal<boolean>>;
  let snapshot: ReturnType<typeof vi.fn>;
  let bandwidth: ReturnType<typeof vi.fn>;
  let updateBackend: ReturnType<typeof vi.fn>;
  let ready: Subject<void>;

  const status: SystemStatusPayload = {
    status: 'active',
    rcloneInfo: null,
    pid: 123,
    stats: { ...DEFAULT_JOB_STATS, bytes: 456, elapsedTime: 60 },
    memory: null,
    hasActiveJobs: false,
  };
  const limit = {
    bytesPerSecond: 1024,
    bytesPerSecondRx: 1024,
    bytesPerSecondTx: 1024,
    rate: '1K',
    loading: false,
  };

  beforeEach(() => {
    accessible = signal(false);
    snapshot = vi.fn().mockResolvedValue(status);
    bandwidth = vi.fn().mockResolvedValue(limit);
    updateBackend = vi.fn();
    ready = new Subject<void>();
    TestBed.configureTestingModule({
      providers: [
        { provide: VaultService, useValue: { isAccessible: accessible } },
        { provide: AppSettingsService, useValue: { options: signal(null) } },
        {
          provide: BackendService,
          useValue: {
            activeBackend: signal('Local'),
            updateActiveBackendStatus: updateBackend,
          },
        },
        {
          provide: SystemInfoService,
          useValue: {
            getSystemStatusSnapshot: snapshot,
            bandwidthLimit: bandwidth,
            setPollerVisibility: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: EventListenersService,
          useValue: {
            listenToRcloneEngineReady: (): Subject<void> => ready,
            listenToVaultState: (): Subject<VaultStatePayload> => new Subject(),
            listenToBandwidthLimitChanged: (): Subject<BandwidthLimitResponse> => new Subject(),
            listenToSystemStatus: (): Subject<SystemStatusPayload> => new Subject(),
          },
        },
      ],
    });
    service = TestBed.inject(RcloneStatusService);
  });

  afterEach(() => vi.restoreAllMocks());

  it('does not query the backend while the vault is inaccessible', async () => {
    await service.refreshStatus();
    expect(snapshot).not.toHaveBeenCalled();
    expect(bandwidth).not.toHaveBeenCalled();
    expect(updateBackend).not.toHaveBeenCalled();
  });

  it('enables polling only while the vault is accessible and the page is visible', () => {
    expect(service.isPollingActive()).toBe(false);
    accessible.set(true);
    expect(service.isPollingActive()).toBe(!document.hidden);

    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(service.isPollingActive()).toBe(false);

    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(service.isPollingActive()).toBe(true);

    accessible.set(false);
    expect(service.isPollingActive()).toBe(false);
  });

  it('refreshes status, telemetry and bandwidth from the backend snapshot', async () => {
    accessible.set(true);
    await service.refreshStatus();
    expect(service.rcloneStatus()).toBe('active');
    expect(service.rclonePID()).toBe(123);
    expect(service.jobStats().bytes).toBe(456);
    expect(service.uptime()).toBe(60);
    expect(service.bandwidthLimit()).toEqual(limit);
    expect(service.isLoading()).toBe(false);
    expect(updateBackend).toHaveBeenCalledWith(
      { type: 'connected' },
      { version: undefined, os: undefined }
    );
  });

  it('refreshes through the same API when the engine becomes ready', async () => {
    accessible.set(true);
    ready.next();
    await vi.waitFor(() => expect(service.bandwidthLimit()).toEqual(limit));
    expect(service.rcloneStatus()).toBe('active');
  });

  it('finishes initial loading when the snapshot request fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    accessible.set(true);
    snapshot.mockRejectedValue(new Error('offline'));
    await service.refreshStatus();
    expect(service.isLoading()).toBe(false);
    expect(service.rcloneStatus()).toBe('inactive');
    expect(bandwidth).not.toHaveBeenCalled();
  });

  it('ignores a snapshot that arrives after the vault becomes inaccessible', async () => {
    let resolve!: (value: SystemStatusPayload) => void;
    snapshot.mockReturnValue(new Promise<SystemStatusPayload>(done => (resolve = done)));
    accessible.set(true);
    const refreshing = service.refreshStatus();
    accessible.set(false);
    resolve(status);
    await refreshing;
    expect(service.rcloneStatus()).toBe('inactive');
    expect(updateBackend).not.toHaveBeenCalled();
    expect(bandwidth).not.toHaveBeenCalled();
  });
});
