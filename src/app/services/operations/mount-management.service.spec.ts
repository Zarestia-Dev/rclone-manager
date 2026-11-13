import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Subject } from 'rxjs';
import { provideTranslateService } from '@ngx-translate/core';
import { MountManagementService } from './mount-management.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { PathService } from '../infrastructure/platform/path.service';
import type { MountedRemote } from '@app/types';

describe('MountManagementService', () => {
  const mount = (fs: string, mountPoint: string): MountedRemote =>
    ({ fs, mount_point: mountPoint }) as MountedRemote;

  let invoke: ReturnType<typeof vi.fn>;
  let mountCacheUpdated: Subject<void>;
  let engineReady: Subject<void>;

  const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve));

  function create(mounts: MountedRemote[] | Promise<MountedRemote[]>): MountManagementService {
    invoke = vi.fn().mockReturnValue(Promise.resolve(mounts));
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        { provide: ApiClientService, useValue: { invoke } },
        {
          provide: EventListenersService,
          useValue: {
            listenToMountCacheUpdated: vi.fn().mockReturnValue(mountCacheUpdated),
            listenToRcloneEngineReady: vi.fn().mockReturnValue(engineReady),
          },
        },
        {
          provide: PathService,
          useValue: { getRemoteNameFromFs: (fs: string): string => fs.split(':')[0] },
        },
      ],
    });
    return TestBed.inject(MountManagementService);
  }

  beforeEach(() => {
    mountCacheUpdated = new Subject<void>();
    engineReady = new Subject<void>();
  });

  it('loads the running mounts as soon as it exists', async () => {
    const service = create([mount('Dropbox:/a', '/mnt/a')]);
    await flush();

    expect(invoke).toHaveBeenCalledWith('get_cached_mounted_remotes', undefined);
    expect(service.mountedRemotes()).toHaveLength(1);
  });

  it('loads again when the mount cache changes or the engine is ready', async () => {
    create([]);
    await flush();
    invoke.mockClear();

    mountCacheUpdated.next();
    engineReady.next();
    await flush();

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('keeps working when the first load fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    invoke = vi.fn().mockRejectedValue(new Error('offline'));
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        { provide: ApiClientService, useValue: { invoke } },
        {
          provide: EventListenersService,
          useValue: {
            listenToMountCacheUpdated: vi.fn().mockReturnValue(mountCacheUpdated),
            listenToRcloneEngineReady: vi.fn().mockReturnValue(engineReady),
          },
        },
        { provide: PathService, useValue: { getRemoteNameFromFs: (fs: string): string => fs } },
      ],
    });
    const service = TestBed.inject(MountManagementService);
    await flush();

    expect(service.mountedRemotes()).toEqual([]);
    error.mockRestore();
  });
});
