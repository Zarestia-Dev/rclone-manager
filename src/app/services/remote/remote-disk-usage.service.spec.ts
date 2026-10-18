import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { provideTranslateService } from '@ngx-translate/core';
import { DiskUsage, VaultStatePayload } from '@app/types';
import { RemoteDiskUsageService } from './remote-disk-usage.service';
import { RemoteFileOperationsService } from './remote-file-operations.service';
import { PathService } from '../infrastructure/platform/path.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { BackendTranslationService } from '../i18n/backend-translation.service';
import { NotificationService } from '../ui/notification.service';
import { VaultService } from '../security/vault.service';

describe('RemoteDiskUsageService', () => {
  let service: RemoteDiskUsageService;
  const accessible = signal(true);
  const getDiskUsage = vi.fn();
  let switched: Subject<void>;
  let vault: Subject<VaultStatePayload>;
  beforeEach(() => {
    accessible.set(true);
    getDiskUsage.mockReset().mockResolvedValue({ total: 100, used: 20, free: 80 });
    switched = new Subject();
    vault = new Subject();
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        { provide: ApiClientService, useValue: {} },
        { provide: NotificationService, useValue: {} },
        { provide: BackendTranslationService, useValue: { translateBackendMessage: String } },
        { provide: VaultService, useValue: { isAccessible: accessible } },
        {
          provide: PathService,
          useValue: {
            normalizeRemoteForRclone: (name: string): string =>
              name.includes(':') || name.startsWith('/') ? name : `${name}:`,
          },
        },
        {
          provide: EventListenersService,
          useValue: {
            listenToBackendSwitched: (): typeof switched => switched,
            listenToVaultState: (): typeof vault => vault,
          },
        },
        { provide: RemoteFileOperationsService, useValue: { getDiskUsage } },
      ],
    });
    service = TestBed.inject(RemoteDiskUsageService);
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('shares concurrent requests, normalizes keys and reuses successful data', async () => {
    const first = service.load('drive');
    const second = service.load('drive:');
    expect(getDiskUsage).toHaveBeenCalledTimes(1);
    expect(await first).toEqual(await second);
    expect(service.usage('drive')).toBe(service.usage('drive:'));
    await service.load('drive');
    expect(getDiskUsage).toHaveBeenCalledTimes(1);
    expect(service.usage('drive')().total).toBe(100);
  });

  it('passes request options and allows a forced result to supersede an older request', async () => {
    let finish!: (usage: DiskUsage) => void;
    getDiskUsage.mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve;
      })
    );
    const old = service.load('drive');
    await service.load('drive', { force: true, source: 'filemanager', group: 'properties' });
    finish({ total: 1 });
    expect(await old).toBeNull();
    expect(service.usage('drive')().total).toBe(100);
    expect(getDiskUsage).toHaveBeenLastCalledWith('drive:', undefined, 'filemanager', 'properties');
  });

  it('caches unsupported capacity, but retries ordinary failures', async () => {
    getDiskUsage.mockRejectedValueOnce(new Error("doesn't support about"));
    expect((await service.load('drive'))?.notSupported).toBe(true);
    await service.load('drive');
    expect(getDiskUsage).toHaveBeenCalledTimes(1);
    service.clear('drive');
    getDiskUsage.mockRejectedValueOnce(new Error('offline'));
    expect(await service.load('drive')).toBeNull();
    expect(service.usage('drive')().errorMessage).toBe('Error: offline');
    await service.load('drive');
    expect(service.usage('drive')().total).toBe(100);
  });

  it('keeps the queue bounded across repeated prefetches and does not wait for a slow batch', async () => {
    vi.useFakeTimers();
    const finish: (() => void)[] = [];
    getDiskUsage.mockImplementation(
      () => new Promise(resolve => finish.push(() => resolve({ total: 100 })))
    );
    const names = Array.from({ length: 8 }, (_, i) => `r${i}`);
    service.prefetch(names);
    expect(getDiskUsage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(getDiskUsage).toHaveBeenCalledTimes(4);
    service.prefetch(names);
    await vi.advanceTimersByTimeAsync(1);
    expect(getDiskUsage).toHaveBeenCalledTimes(4);
    finish.shift()?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(getDiskUsage).toHaveBeenCalledTimes(5);
    finish.splice(0).forEach(resolve => resolve());
    await vi.advanceTimersByTimeAsync(1);
    finish.splice(0).forEach(resolve => resolve());
    await vi.runAllTimersAsync();
    expect(getDiskUsage).toHaveBeenCalledTimes(8);
  });

  it('invalidates on backend switch and ignores late responses', async () => {
    let finish!: (value: DiskUsage) => void;
    getDiskUsage.mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve;
      })
    );
    const usage = service.usage('drive');
    const old = service.load('drive');
    switched.next();
    await service.load('drive');
    finish({ total: 1 });
    expect(await old).toBeNull();
    expect(usage().total).toBe(100);
  });

  it('does not request capacity for an empty target', async () => {
    expect(await service.load('')).toBeNull();
    expect(await service.load('  ')).toBeNull();
    expect(getDiskUsage).not.toHaveBeenCalled();
  });

  it('clears queued work and prevents loading while the vault is locked', async () => {
    vi.useFakeTimers();
    service.prefetch(['drive']);
    accessible.set(false);
    vault.next({ isLocked: true } as VaultStatePayload);
    await vi.runAllTimersAsync();
    expect(await service.load('drive')).toBeNull();
    expect(getDiskUsage).not.toHaveBeenCalled();
    expect(service.usage('drive')().total).toBeUndefined();
  });
  it('starts capacity reads for a new backend while old transports remain pending', async () => {
    vi.useFakeTimers();
    getDiskUsage.mockImplementation(() => new Promise(() => undefined));
    service.prefetch(['a', 'b', 'c', 'd']);
    await vi.advanceTimersByTimeAsync(0);
    expect(getDiskUsage).toHaveBeenCalledTimes(4);
    switched.next();
    getDiskUsage.mockResolvedValue({ total: 200 });
    service.prefetch(['fresh']);
    await vi.runAllTimersAsync();
    expect(service.usage('fresh')().total).toBe(200);
    expect(getDiskUsage).toHaveBeenCalledTimes(5);
  });
});
