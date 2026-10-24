import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Automation } from '@app/types';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { BackendTranslationService } from '../i18n/backend-translation.service';
import { NotificationService } from '../ui/notification.service';
import { AutomationService } from './automation.service';

describe('AutomationService cache', () => {
  let service: AutomationService;
  let changed: Subject<string>;
  let invoke: ReturnType<typeof vi.fn>;

  const automation: Automation = {
    id: 'automation-旅行',
    automationType: 'sync',
    remoteName: 'Arşiv & photos',
    profileName: 'custom',
    status: 'enabled',
    backendName: 'Local',
    args: { srcPaths: [], dstPaths: [], remoteName: 'Arşiv & photos', profileName: 'custom' },
    createdAt: '2026-10-23T00:00:00Z',
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    stoppedCount: 0,
  };

  beforeEach(async () => {
    changed = new Subject();
    invoke = vi.fn().mockResolvedValue([automation]);
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        { provide: ApiClientService, useValue: { invoke } },
        { provide: BackendTranslationService, useValue: {} },
        { provide: NotificationService, useValue: {} },
        {
          provide: EventListenersService,
          useValue: { listenToAutomationsCacheChanged: (): Subject<string> => changed },
        },
      ],
    });
    service = TestBed.inject(AutomationService);
    await vi.waitFor(() => expect(service.automations()).toEqual([automation]));
  });

  afterEach(() => vi.restoreAllMocks());

  it('loads once initially and replaces the cache when a backend change arrives', async () => {
    expect(invoke).toHaveBeenCalledTimes(1);
    const disabled: Automation = { ...automation, status: 'disabled' };
    invoke.mockResolvedValueOnce([disabled]);
    changed.next('automation_updated');
    await vi.waitFor(() => expect(service.automations()).toEqual([disabled]));

    invoke.mockResolvedValueOnce([]);
    changed.next('remote_automations_removed');
    await vi.waitFor(() => expect(service.automations()).toEqual([]));
  });

  it('keeps the previous cache when a refresh fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new Error('backend unavailable');
    invoke.mockRejectedValueOnce(error);
    await service.refreshAutomations();
    expect(service.automations()).toEqual([automation]);
    expect(log).toHaveBeenCalledWith('Failed to refresh automations:', error);
  });

  it('propagates toggle failures without changing cached scheduling state', async () => {
    const error = new Error('schedule rejected');
    invoke.mockRejectedValueOnce(error);
    await expect(service.toggleAutomation(automation.id)).rejects.toBe(error);
    expect(service.automations()).toEqual([automation]);
  });

  it('returns invalid cron results as data for the form to display', async () => {
    const result = { isValid: false, errorMessage: 'invalid expression' };
    invoke.mockResolvedValueOnce(result);
    expect(await service.validateCron('')).toEqual(result);
    expect(invoke).toHaveBeenLastCalledWith('validate_cron', { cronExpression: '' });
  });

  it('unsubscribes from backend changes when destroyed', () => {
    invoke.mockClear();
    TestBed.resetTestingModule();
    changed.next('automation_updated');
    expect(invoke).not.toHaveBeenCalled();
  });
});
