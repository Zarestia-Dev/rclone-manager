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
    await service.loadAllFlagFields();
    await service.getGroupedOptions();
    await service.loadServeFlagFields('http');
    expect(service.mountTypes()).toEqual(['cmount']);
    expect(service.serveFlagsMap().has('http')).toBe(true);
    switched.next();
    expect(service.allFlagFields()).toBeNull();
    expect(service.groupedOptions()).toBeNull();
    expect(service.mountTypes()).toBeNull();
    expect(service.serveFlagsMap().size).toBe(0);
    getMountTypes.mockResolvedValue(['mount']);
    getServeTypes.mockResolvedValue(['webdav']);
    await service.loadAllFlagFields();
    expect(service.mountTypes()).toEqual(['mount']);
    expect(service.availableServeTypes()).toEqual(['webdav']);
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
});
