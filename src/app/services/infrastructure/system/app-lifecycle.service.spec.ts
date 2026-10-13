import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Observable, Subject } from 'rxjs';
import { provideTranslateService } from '@ngx-translate/core';
import { AppLifecycleService } from './app-lifecycle.service';
import { ApiClientService } from '../platform/api-client.service';
import { EventListenersService } from './event-listeners.service';
import { NotificationService } from '../../ui/notification.service';
import { NautilusService } from '../../ui/nautilus.service';
import { FlowOverlayService } from '../../ui/flow-overlay.service';
import { MainUiOverlayService } from '../../ui/main-ui-overlay.service';
import { ActiveOperationsSummary } from '@app/types';

describe('AppLifecycleService', () => {
  let service: AppLifecycleService;
  let mockApiClient: { invoke: ReturnType<typeof vi.fn> };
  let mockNotificationService: { confirmModal: ReturnType<typeof vi.fn> };
  let mockNautilusService: { isStandaloneWindow: ReturnType<typeof vi.fn> };
  let mockFlowOverlayService: { isStandaloneWindow: ReturnType<typeof vi.fn> };
  let mockMainUiOverlayService: { isStandaloneWindow: ReturnType<typeof vi.fn> };
  let appExitRequested$: Subject<ActiveOperationsSummary>;

  beforeEach(() => {
    appExitRequested$ = new Subject<ActiveOperationsSummary>();
    mockApiClient = {
      invoke: vi.fn().mockResolvedValue(null),
    };
    mockNotificationService = {
      confirmModal: vi.fn().mockResolvedValue(true),
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
        { provide: ApiClientService, useValue: mockApiClient },
        { provide: NotificationService, useValue: mockNotificationService },
        { provide: NautilusService, useValue: mockNautilusService },
        { provide: FlowOverlayService, useValue: mockFlowOverlayService },
        { provide: MainUiOverlayService, useValue: mockMainUiOverlayService },
        {
          provide: EventListenersService,
          useValue: {
            listenToAppExitRequested: (): Observable<ActiveOperationsSummary> => appExitRequested$,
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
});
