import { staticFlagDefinitions } from './flag-definitions';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { provideTranslateService } from '@ngx-translate/core';
import { VaultStatePayload } from '@app/types';
import { FlagConfigService } from './flag-config.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { MountManagementService } from '../operations/mount-management.service';
import { ServeManagementService } from '../operations/serve-management.service';
import { NotificationService } from '../ui/notification.service';
import { BackendTranslationService } from '../i18n/backend-translation.service';

describe('FlagConfigService cache scope', () => {
  let service: FlagConfigService;
  let switched: Subject<void>;
  let vault: Subject<VaultStatePayload>;
  const invoke = vi.fn();
  const getMountTypes = vi.fn();
  const getServeTypes = vi.fn();
  beforeEach(() => {
    switched = new Subject();
    vault = new Subject();
    invoke.mockReset().mockResolvedValue([]);
    getMountTypes.mockReset().mockResolvedValue(['cmount']);
    getServeTypes.mockReset().mockResolvedValue(['http']);
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        { provide: ApiClientService, useValue: { invoke } },
        { provide: NotificationService, useValue: {} },
        { provide: BackendTranslationService, useValue: {} },
        { provide: MountManagementService, useValue: { getMountTypes } },
        { provide: ServeManagementService, useValue: { getServeTypes } },
        {
          provide: EventListenersService,
          useValue: {
            listenToBackendSwitched: (): Subject<void> => switched,
            listenToVaultState: (): Subject<VaultStatePayload> => vault,
          },
        },
      ],
    });
    service = TestBed.inject(FlagConfigService);
  });

  it('loads lazily and invalidates all backend-specific flag caches', async () => {
    expect(invoke).not.toHaveBeenCalled();
    const firstFields = await service.loadAllFlagFields();
    await service.getGroupedOptions();
    const firstServeFields = await service.loadServeFlagFields('http');
    expect(service.mountTypes()).toEqual(['cmount']);
    expect(firstServeFields.length).toBeGreaterThan(0);
    switched.next();
    expect(service.groupedOptions()).toBeNull();
    expect(service.mountTypes()).toBeNull();
    getMountTypes.mockResolvedValue(['mount']);
    getServeTypes.mockResolvedValue(['webdav']);
    const refreshedFields = await service.loadAllFlagFields();
    const refreshedServeFields = await service.loadServeFlagFields('http');
    expect(refreshedFields).not.toBe(firstFields);
    expect(refreshedServeFields).not.toBe(firstServeFields);
    expect(invoke.mock.calls.filter(([command]) => command === 'get_serve_flags')).toHaveLength(2);
    expect(service.mountTypes()).toEqual(['mount']);
    expect(service.availableServeTypes()).toEqual(['webdav']);
  });

  it.each([
    { block: 'main', option: 'AskPassword', value: false },
    { block: 'main', option: 'Retries', value: 0 },
    { block: 'main', option: 'LogFile', value: '' },
    { block: 'filter', option: 'ExcludeRule', value: ['Arşiv & 旅行', 'folder/path'] },
  ])(
    'applies the live option $block.$option using the backend command contract',
    async ({ block, option, value }) => {
      await service.applyOption(block, option, value);
      expect(invoke).toHaveBeenCalledExactlyOnceWith('set_rclone_option', {
        blockName: block,
        optionName: option,
        value,
      });
    }
  );

  it('propagates live option failures so the caller can retain unsaved changes', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new Error('option rejected');
    invoke.mockRejectedValueOnce(error);
    try {
      await expect(service.applyOption('main', 'LogLevel', 'DEBUG')).rejects.toBe(error);
    } finally {
      log.mockRestore();
    }
  });

  it('does not wait for a previous backend flag request that never completes', async () => {
    invoke.mockReturnValueOnce(new Promise(() => undefined));
    const old = service.getGroupedOptions();
    const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    switched.next();
    await rejected;
    invoke.mockResolvedValueOnce({ fresh: [] });
    expect(await service.getGroupedOptions()).toEqual({ fresh: [] });
  });

  it('invalidates user-specific option values when the vault locks', async () => {
    await service.getGroupedOptions();
    vault.next({ isLocked: true } as VaultStatePayload);
    expect(service.groupedOptions()).toBeNull();
  });
  it('does not mutate shared flag definitions while decorating backend choices', async () => {
    const shared = staticFlagDefinitions['mount'].find(option => option.Name === 'mountType');
    const before = shared?.Examples;
    const sharedServe = staticFlagDefinitions['serve'].find(option => option.Name === 'type');
    const beforeServe = sharedServe?.Examples;
    const fields = await service.loadAllFlagFields();
    const mount = fields.mount.find(option => option.Name === 'mountType');
    expect(mount).not.toBe(shared);
    expect(mount?.Examples?.map(example => example.Value)).toEqual(['cmount']);
    expect(shared?.Examples).toBe(before);
    const serve = await service.loadServeFlagFields('http');
    expect(
      serve.find(option => option.Name === 'type')?.Examples?.map(example => example.Value)
    ).toEqual(['http']);
    expect(sharedServe?.Examples).toBe(beforeServe);
  });
  it('loads a focused section without fetching unrelated mount or serve metadata', async () => {
    await Promise.all([service.loadConfigFields(['sync']), service.loadConfigFields(['sync'])]);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('get_operation_flags', { operation: 'sync' });
    expect(getMountTypes).not.toHaveBeenCalled();
    expect(getServeTypes).not.toHaveBeenCalled();
    await service.loadAllFlagFields();
    expect(
      invoke.mock.calls.filter(
        ([command, args]) => command === 'get_operation_flags' && args.operation === 'sync'
      )
    ).toHaveLength(1);
  });
  it('retries failed subtype discovery instead of caching an empty successful result', async () => {
    getMountTypes.mockRejectedValueOnce(new Error('offline'));
    await expect(service.loadConfigFields(['mount'])).rejects.toThrow('offline');
    expect(service.mountTypes()).toBeNull();
    const fields = await service.loadConfigFields(['mount']);
    expect(
      fields.mount
        ?.find(field => field.Name === 'mountType')
        ?.Examples?.map(example => example.Value)
    ).toEqual(['cmount']);
  });
});
