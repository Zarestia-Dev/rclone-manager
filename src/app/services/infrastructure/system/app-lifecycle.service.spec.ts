import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { VaultService } from '../../security/vault.service';
import { Observable, of, Subject } from 'rxjs';
import { provideTranslateService } from '@ngx-translate/core';
import { AppLifecycleService } from './app-lifecycle.service';
import { ApiClientService } from '../platform/api-client.service';
import { EventListenersService } from './event-listeners.service';
import { NotificationService } from '../../ui/notification.service';
import { NautilusService } from '../../ui/nautilus.service';
import { FlowOverlayService } from '../../ui/flow-overlay.service';
import { MainUiOverlayService } from '../../ui/main-ui-overlay.service';
import { ActiveOperationsSummary } from '@app/types';
import { getCurrentWindow } from '@tauri-apps/api/window';

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({ label: 'main' })),
}));

describe('AppLifecycleService', () => {
  let service: AppLifecycleService;
  const locked = signal(false);
  const statusKnown = signal(true);
  let mockApiClient: { invoke: ReturnType<typeof vi.fn> };
  let mockNotificationService: {
    confirmModal: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
  };
  let mockNautilusService: { isStandaloneWindow: ReturnType<typeof vi.fn> };
  let mockFlowOverlayService: { isStandaloneWindow: ReturnType<typeof vi.fn> };
  let mockMainUiOverlayService: { isStandaloneWindow: ReturnType<typeof vi.fn> };
  let appExitRequested$: Subject<ActiveOperationsSummary>;

  beforeEach(() => {
    locked.set(false);
    statusKnown.set(true);
    appExitRequested$ = new Subject<ActiveOperationsSummary>();
    mockApiClient = {
      invoke: vi.fn().mockResolvedValue(null),
    };
    mockNotificationService = {
      confirmModal: vi.fn().mockResolvedValue(true),
      showError: vi.fn(),
    };
    mockNautilusService = {
      isStandaloneWindow: vi.fn().mockReturnValue(false),
    };
    mockFlowOverlayService = {
      isStandaloneWindow: vi.fn().mockReturnValue(false),
    };
    mockMainUiOverlayService = {
      isStandaloneWindow: vi.fn().mockReturnValue(false),
    };

    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        AppLifecycleService,
        {
          provide: VaultService,
          useValue: {
            isVaultLocked: locked,
            isStatusKnown: statusKnown,
            isAccessible: (): boolean => statusKnown() && !locked(),
          },
        },
        { provide: ApiClientService, useValue: mockApiClient },
        { provide: NotificationService, useValue: mockNotificationService },
        { provide: NautilusService, useValue: mockNautilusService },
        { provide: FlowOverlayService, useValue: mockFlowOverlayService },
        { provide: MainUiOverlayService, useValue: mockMainUiOverlayService },
        {
          provide: EventListenersService,
          useValue: {
            listenToAppExitRequested: (): Observable<ActiveOperationsSummary> => appExitRequested$,
            whenAppExitListenerReady: (): Observable<void> => of(undefined),
          },
        },
      ],
    });

    service = TestBed.inject(AppLifecycleService);
  });

  it('should initialize and check for pending exit requests', async () => {
    const summary: ActiveOperationsSummary = {
      hasActiveOperations: true,
      activeJobsCount: 1,
      activeMountsCount: 2,
      activeServesCount: 0,
    };
    mockApiClient.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'check_pending_app_exit') {
        return summary;
      }
      return null;
    });

    service.initialize();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockNotificationService.confirmModal).toHaveBeenCalled();
    expect(mockApiClient.invoke).toHaveBeenCalledWith('shutdown_app');
  });

  it('waits for event registration before consuming a saved exit request', () => {
    const ready = new Subject<void>();
    vi.spyOn(TestBed.inject(EventListenersService), 'whenAppExitListenerReady').mockReturnValue(
      ready
    );
    service.initialize();
    expect(mockApiClient.invoke).not.toHaveBeenCalled();
    ready.next();
    expect(mockApiClient.invoke).toHaveBeenCalledWith('check_pending_app_exit');
  });

  it('should prompt confirmation when app exit event is received and shutdown on confirm', async () => {
    service.initialize();

    const summary: ActiveOperationsSummary = {
      hasActiveOperations: true,
      activeJobsCount: 1,
      activeMountsCount: 0,
      activeServesCount: 0,
    };
    appExitRequested$.next(summary);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockNotificationService.confirmModal).toHaveBeenCalled();
    expect(mockApiClient.invoke).toHaveBeenCalledWith('shutdown_app');
  });

  it('should not shutdown if confirmation is canceled', async () => {
    mockNotificationService.confirmModal.mockResolvedValue(false);
    service.initialize();

    const summary: ActiveOperationsSummary = {
      hasActiveOperations: true,
      activeJobsCount: 1,
      activeMountsCount: 0,
      activeServesCount: 0,
    };
    appExitRequested$.next(summary);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockNotificationService.confirmModal).toHaveBeenCalled();
    expect(mockApiClient.invoke).not.toHaveBeenCalledWith('shutdown_app');
  });

  it('offers inline confirmation while locked without opening a protected overlay', async () => {
    locked.set(true);
    service.initialize();
    appExitRequested$.next({
      hasActiveOperations: true,
      activeJobsCount: 0,
      activeMountsCount: 0,
      activeServesCount: 0,
    });
    await Promise.resolve();
    expect(service.lockedExitRequested()).toBe(true);
    expect(mockNotificationService.confirmModal).not.toHaveBeenCalled();
    expect(mockApiClient.invoke).not.toHaveBeenCalledWith('shutdown_app');
    service.cancelLockedExit();
    expect(service.lockedExitRequested()).toBe(false);
    await service.confirmLockedExit();
    expect(mockApiClient.invoke).not.toHaveBeenCalledWith('shutdown_app');
  });

  it('confirms a locked exit once and permits retry if shutdown fails', async () => {
    locked.set(true);
    service.lockedExitRequested.set(true);
    let finish!: () => void;
    mockApiClient.invoke.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        })
    );
    const first = service.confirmLockedExit();
    await service.confirmLockedExit();
    service.cancelLockedExit();
    expect(service.isQuitting()).toBe(true);
    expect(service.lockedExitRequested()).toBe(true);
    expect(mockApiClient.invoke).toHaveBeenCalledTimes(1);
    finish();
    await first;
    expect(service.isQuitting()).toBe(false);
    expect(service.lockedExitRequested()).toBe(false);
    service.lockedExitRequested.set(true);
    mockApiClient.invoke.mockRejectedValueOnce(new Error('shutdown failed'));
    await expect(service.confirmLockedExit()).rejects.toThrow('shutdown failed');
    expect(service.isQuitting()).toBe(false);
    expect(service.lockedExitRequested()).toBe(true);
  });

  it.each([true, false])(
    'waits for vault initialization before restoring an exit request (locked: %s)',
    async isLocked => {
      statusKnown.set(false);
      mockApiClient.invoke.mockResolvedValueOnce({
        hasActiveOperations: true,
        activeJobsCount: 1,
        activeMountsCount: 0,
        activeServesCount: 0,
      });
      service.initialize();
      await Promise.resolve();
      TestBed.tick();
      expect(mockNotificationService.confirmModal).not.toHaveBeenCalled();
      expect(service.lockedExitRequested()).toBe(false);
      locked.set(isLocked);
      statusKnown.set(true);
      TestBed.tick();
      await Promise.resolve();
      expect(service.lockedExitRequested()).toBe(isLocked);
      expect(mockNotificationService.confirmModal).toHaveBeenCalledTimes(isLocked ? 0 : 1);
      if (isLocked) expect(mockApiClient.invoke).not.toHaveBeenCalledWith('shutdown_app');
      else expect(mockApiClient.invoke).toHaveBeenCalledWith('shutdown_app');
    }
  );

  it('refreshes a redacted exit notice when startup finishes with an unlocked vault', async () => {
    statusKnown.set(false);
    mockApiClient.invoke.mockResolvedValueOnce({
      hasActiveOperations: true,
      activeJobsCount: 0,
      activeMountsCount: 0,
      activeServesCount: 0,
    });
    service.initialize();
    await Promise.resolve();
    TestBed.tick();
    statusKnown.set(true);
    TestBed.tick();
    await Promise.resolve();
    expect(mockApiClient.invoke).toHaveBeenCalledWith('request_app_exit');
    expect(mockNotificationService.confirmModal).not.toHaveBeenCalled();
    expect(mockApiClient.invoke).not.toHaveBeenCalledWith('shutdown_app');
  });

  it('preserves confirmation through unknown status and refreshes the request after unlocking', async () => {
    locked.set(true);
    service.initialize();
    appExitRequested$.next({
      hasActiveOperations: true,
      activeJobsCount: 0,
      activeMountsCount: 0,
      activeServesCount: 0,
    });
    TestBed.tick();
    statusKnown.set(false);
    TestBed.tick();
    expect(service.lockedExitRequested()).toBe(true);
    expect(mockApiClient.invoke).not.toHaveBeenCalledWith('request_app_exit');

    statusKnown.set(true);
    TestBed.tick();
    expect(service.lockedExitRequested()).toBe(true);
    locked.set(false);
    TestBed.tick();
    await Promise.resolve();
    expect(service.lockedExitRequested()).toBe(false);
    expect(mockApiClient.invoke).toHaveBeenCalledWith('request_app_exit');
    expect(mockNotificationService.confirmModal).not.toHaveBeenCalled();
  });

  it('moves an open confirmation to the lock screen if the vault locks', async () => {
    let finish!: (confirmed: boolean) => void;
    mockNotificationService.confirmModal.mockReturnValueOnce(
      new Promise<boolean>(resolve => {
        finish = resolve;
      })
    );
    service.initialize();
    appExitRequested$.next({
      hasActiveOperations: true,
      activeJobsCount: 2,
      activeMountsCount: 1,
      activeServesCount: 0,
    });
    locked.set(true);
    finish(false);
    await Promise.resolve();
    TestBed.tick();
    expect(service.lockedExitRequested()).toBe(true);
    expect(mockApiClient.invoke).not.toHaveBeenCalledWith('shutdown_app');
  });

  it('handles shutdown errors from exit events without leaving confirmation blocked', async () => {
    const error = new Error('shutdown failed');
    mockApiClient.invoke.mockImplementation(async (command: string) => {
      if (command === 'shutdown_app') throw error;
      return null;
    });
    service.initialize();
    const summary: ActiveOperationsSummary = {
      hasActiveOperations: true,
      activeJobsCount: 1,
      activeMountsCount: 0,
      activeServesCount: 0,
    };
    appExitRequested$.next(summary);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockNotificationService.showError).toHaveBeenCalledWith(error);
    appExitRequested$.next(summary);
    expect(mockNotificationService.confirmModal).toHaveBeenCalledTimes(2);
  });

  it('should skip exit handling in standalone windows', () => {
    mockNautilusService.isStandaloneWindow.mockReturnValue(true);
    service.initialize();

    const summary: ActiveOperationsSummary = {
      hasActiveOperations: true,
      activeJobsCount: 1,
      activeMountsCount: 0,
      activeServesCount: 0,
    };
    appExitRequested$.next(summary);

    expect(mockNotificationService.confirmModal).not.toHaveBeenCalled();
  });

  it('does not consume a pending main-window exit from a standalone dialog', () => {
    const originalUrl = window.location.href;
    try {
      window.history.replaceState(null, '', '?standalone=dialog&dialogType=logs');
      service.initialize();
      expect(mockApiClient.invoke).not.toHaveBeenCalled();
    } finally {
      window.history.replaceState(null, '', originalUrl);
    }
  });

  it('skips native secondary windows before their standalone services initialize', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__');
    try {
      Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
      vi.mocked(getCurrentWindow).mockReturnValue({ label: 'nautilus-remote' } as ReturnType<
        typeof getCurrentWindow
      >);
      service.initialize();
      expect(mockApiClient.invoke).not.toHaveBeenCalled();
    } finally {
      if (descriptor) Object.defineProperty(window, '__TAURI_INTERNALS__', descriptor);
      else Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    }
  });
});
