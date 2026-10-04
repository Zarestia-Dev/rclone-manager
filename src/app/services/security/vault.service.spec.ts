import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { VaultService } from './vault.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { NotificationService } from '../ui/notification.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { TranslateService } from '@ngx-translate/core';
import { BackendTranslationService } from '../i18n/backend-translation.service';
import { SseClientService } from '../infrastructure/platform/sse-client.service';
import { VaultStatePayload } from '@app/types';

describe('VaultService', () => {
  let service: VaultService;
  let vaultStateSubject: Subject<VaultStatePayload>;
  let apiClientMock: { invoke: ReturnType<typeof vi.fn> };
  let eventListenersMock: {
    listenToVaultState: ReturnType<typeof vi.fn>;
    listenToServerConnection: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vaultStateSubject = new Subject<VaultStatePayload>();
    apiClientMock = { invoke: vi.fn() };
    eventListenersMock = {
      listenToVaultState: vi.fn().mockReturnValue(vaultStateSubject.asObservable()),
      listenToServerConnection: vi.fn().mockReturnValue(of()),
    };

    TestBed.configureTestingModule({
      providers: [
        VaultService,
        { provide: EventListenersService, useValue: eventListenersMock },
        { provide: ApiClientService, useValue: apiClientMock },
        {
          provide: NotificationService,
          useValue: {
            showSuccess: vi.fn(),
            showError: vi.fn(),
            showWarning: vi.fn(),
            showInfo: vi.fn(),
          },
        },
        {
          provide: TranslateService,
          useValue: {
            instant: vi.fn((key: string) => key),
          },
        },
        {
          provide: BackendTranslationService,
          useValue: {
            translateBackendMessage: vi.fn((err: unknown) => String(err)),
          },
        },
        {
          provide: SseClientService,
          useValue: {
            listen: vi.fn().mockReturnValue(of()),
          },
        },
      ],
    });

    service = TestBed.inject(VaultService);
  });

  it('should initialize with default signals and unknown status', () => {
    expect(service.isStatusKnown()).toBe(false);
    expect(service.isVaultEnabled()).toBe(false);
    expect(service.isVaultLocked()).toBe(false);
    expect(service.lockTimeoutSecs()).toBeNull();
  });

  it('should update signals and mark status known on vault state events', () => {
    vaultStateSubject.next({
      event: 'locked',
      isLocked: true,
      isEnabled: true,
      lockTimeout: 300,
    });

    expect(service.isStatusKnown()).toBe(true);
    expect(service.isVaultEnabled()).toBe(true);
    expect(service.isVaultLocked()).toBe(true);
    expect(service.lockTimeoutSecs()).toBe(300);

    vaultStateSubject.next({
      event: 'unlocked',
      isLocked: false,
      isEnabled: true,
      lockTimeout: null,
    });

    expect(service.isVaultLocked()).toBe(false);
    expect(service.lockTimeoutSecs()).toBeNull();
  });

  it('should explicitly clear timeout when null is received', () => {
    vaultStateSubject.next({
      event: 'timeout_changed',
      isLocked: false,
      isEnabled: true,
      lockTimeout: 600,
    });
    expect(service.lockTimeoutSecs()).toBe(600);

    vaultStateSubject.next({
      event: 'timeout_changed',
      isLocked: false,
      isEnabled: true,
      lockTimeout: null,
    });
    expect(service.lockTimeoutSecs()).toBeNull();
  });

  it('should check vault status and update signals', async () => {
    apiClientMock.invoke.mockResolvedValueOnce({
      enabled: true,
      isLocked: true,
      lockTimeoutSecs: 600,
    });

    const info = await service.checkVaultStatus();

    expect(info.enabled).toBe(true);
    expect(service.isStatusKnown()).toBe(true);
    expect(service.isVaultEnabled()).toBe(true);
    expect(service.isVaultLocked()).toBe(true);
    expect(service.lockTimeoutSecs()).toBe(600);
  });

  it('should mark status as unknown and throw if checkVaultStatus fails', async () => {
    apiClientMock.invoke.mockRejectedValueOnce(new Error('Backend offline'));

    await expect(service.checkVaultStatus()).rejects.toThrow('Backend offline');
    expect(service.isStatusKnown()).toBe(false);
  });

  it('should invoke unlock and lock without optimistically mutating signals', async () => {
    apiClientMock.invoke.mockResolvedValue(undefined);

    await service.unlockVault('test-password');
    expect(apiClientMock.invoke).toHaveBeenCalledWith('unlock_vault', {
      password: 'test-password',
    });

    await service.lockVault();
    expect(apiClientMock.invoke).toHaveBeenCalledWith('lock_vault', undefined);
  });

  it('should invoke enable and disable commands', async () => {
    apiClientMock.invoke.mockResolvedValue(undefined);

    await service.enableVault('test-password', 900);
    expect(apiClientMock.invoke).toHaveBeenCalledWith('enable_vault', {
      password: 'test-password',
      timeoutSecs: 900,
    });

    await service.disableVault('test-password');
    expect(apiClientMock.invoke).toHaveBeenCalledWith('disable_vault', {
      password: 'test-password',
    });
  });

  it('should invoke set_vault_lock_timeout with notification', async () => {
    apiClientMock.invoke.mockResolvedValue(undefined);

    await service.setVaultLockTimeout(120);
    expect(apiClientMock.invoke).toHaveBeenCalledWith('set_vault_lock_timeout', {
      timeoutSecs: 120,
    });
  });
  it('does not overwrite a lock event with an older status response', async () => {
    let resolve!: (info: { enabled: boolean; isLocked: boolean }) => void;
    apiClientMock.invoke.mockReturnValueOnce(
      new Promise(done => {
        resolve = done;
      })
    );
    const pending = service.checkVaultStatus();
    vaultStateSubject.next({
      event: 'auto_locked',
      isLocked: true,
      isEnabled: true,
      lockTimeout: null,
    });
    resolve({ enabled: true, isLocked: false });
    await pending;
    expect(service.isVaultLocked()).toBe(true);
  });

  it('does not discard a newer event when an old query fails', async () => {
    let reject!: (error: Error) => void;
    apiClientMock.invoke.mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail;
      })
    );
    const pending = service.checkVaultStatus();
    vaultStateSubject.next({ event: 'locked', isLocked: true, isEnabled: true, lockTimeout: null });
    reject(new Error('Disconnected'));
    await expect(pending).rejects.toThrow('Disconnected');
    expect(service.isStatusKnown()).toBe(true);
    expect(service.isVaultLocked()).toBe(true);
  });
});
