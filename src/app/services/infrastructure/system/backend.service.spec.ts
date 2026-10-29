import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { EMPTY } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendInfo } from '@app/types';
import { AppSettingsService } from '../../settings/app-settings.service';
import { BackendTranslationService } from '../../i18n/backend-translation.service';
import { NotificationService } from '../../ui/notification.service';
import { ApiClientService } from '../platform/api-client.service';
import { EventListenersService } from './event-listeners.service';
import { BackendService } from './backend.service';

describe('BackendService resource loading', () => {
  const invoke = vi.fn();
  const localBackend: BackendInfo = {
    name: 'Local',
    isLocal: true,
    isAuthGenerated: false,
    host: '127.0.0.1',
    port: 51900,
    isActive: true,
    hasAuth: true,
    username: 'user & 旅行',
    hasConfigPassword: false,
    configPath: '/old/rclone.conf',
  };

  beforeEach(() => {
    invoke.mockReset();
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        { provide: ApiClientService, useValue: { invoke } },
        { provide: NotificationService, useValue: {} },
        {
          provide: BackendTranslationService,
          useValue: {
            translateBackendMessage: (error: unknown): string =>
              typeof error === 'string' ? error : (error as Error).message,
          },
        },
        { provide: AppSettingsService, useValue: {} },
        {
          provide: EventListenersService,
          useValue: {
            listenToRcloneEngineReady: (): typeof EMPTY => EMPTY,
            listenToBackendSwitched: (): typeof EMPTY => EMPTY,
            listenToSettingsCategory: (): typeof EMPTY => EMPTY,
          },
        },
      ],
    });
  });

  it('tracks pending requests, loaded backends, and a later empty refresh', async () => {
    let finish!: (value: BackendInfo[]) => void;
    invoke.mockImplementation(
      () =>
        new Promise<BackendInfo[]>(resolve => {
          finish = resolve;
        })
    );
    const service = TestBed.inject(BackendService);
    TestBed.tick();
    expect(service.isLoading()).toBe(true);
    const backend: BackendInfo = {
      name: 'NAS & 旅行',
      isLocal: false,
      isAuthGenerated: false,
      host: '127.0.0.1',
      port: 51900,
      isActive: true,
      hasAuth: false,
      hasConfigPassword: false,
    };
    finish([backend]);
    await TestBed.inject(ApplicationRef).whenStable();
    expect(service.isLoading()).toBe(false);
    expect(service.backends()).toEqual([backend]);
    expect(service.activeBackend()).toBe(backend.name);

    service.backendData.reload();
    TestBed.tick();
    expect(service.isLoading()).toBe(true);
    finish([]);
    await TestBed.inject(ApplicationRef).whenStable();
    expect(service.isLoading()).toBe(false);
    expect(service.backends()).toEqual([]);
  });

  it('ends loading when the resource reports an error', async () => {
    const error = new Error('backend unavailable');
    invoke.mockRejectedValue(error);
    const service = TestBed.inject(BackendService);
    TestBed.tick();
    await TestBed.inject(ApplicationRef).whenStable();
    expect(service.isLoading()).toBe(false);
    expect(service.backendData.error()).toBe(error);
  });

  it('shares a pending initial load and waits until the backend list is available', async () => {
    let finish!: (value: BackendInfo[]) => void;
    invoke.mockImplementation(() => new Promise<BackendInfo[]>(resolve => (finish = resolve)));
    const service = TestBed.inject(BackendService);
    const first = vi.fn();
    const second = vi.fn();
    const requests = [service.loadBackends().then(first), service.loadBackends().then(second)];
    TestBed.tick();
    await Promise.resolve();
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('list_backends', undefined);

    finish([localBackend]);
    await TestBed.inject(ApplicationRef).whenStable();
    await Promise.all(requests);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(service.backends()).toEqual([localBackend]);
  });

  it('waits for a fresh reload despite a previously emitted completion', async () => {
    invoke.mockResolvedValue([localBackend]);
    const service = TestBed.inject(BackendService);
    TestBed.tick();
    await TestBed.inject(ApplicationRef).whenStable();

    let finish!: (value: BackendInfo[]) => void;
    invoke.mockImplementation(() => new Promise<BackendInfo[]>(resolve => (finish = resolve)));
    const complete = vi.fn();
    const request = service.loadBackends().then(complete);
    await Promise.resolve();
    expect(complete).not.toHaveBeenCalled();
    TestBed.tick();
    expect(service.isLoading()).toBe(true);

    finish([]);
    await TestBed.inject(ApplicationRef).whenStable();
    await request;
    expect(complete).toHaveBeenCalledOnce();
    expect(service.backends()).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('rejects failed loads and allows a later retry', async () => {
    const error = new Error('list unavailable');
    invoke.mockRejectedValue(error);
    const service = TestBed.inject(BackendService);
    const failed = expect(service.loadBackends()).rejects.toBe(error);
    TestBed.tick();
    await TestBed.inject(ApplicationRef).whenStable();
    await failed;

    invoke.mockResolvedValue([localBackend]);
    const retry = service.loadBackends();
    TestBed.tick();
    await TestBed.inject(ApplicationRef).whenStable();
    await retry;
    expect(service.backends()).toEqual([localBackend]);
    expect(service.backendData.error()).toBeUndefined();
  });

  it.each(['/home/旅行 & files/rclone.conf', undefined])(
    'waits for the local backend before updating config path %s',
    async configPath => {
      let finish!: (value: BackendInfo[]) => void;
      invoke
        .mockResolvedValue([localBackend])
        .mockImplementationOnce(() => new Promise<BackendInfo[]>(resolve => (finish = resolve)));
      const service = TestBed.inject(BackendService);
      const update = service.updateLocalBackendConfigPath(configPath);
      TestBed.tick();
      await Promise.resolve();
      expect(invoke).not.toHaveBeenCalledWith('update_backend', expect.anything());

      finish([localBackend]);
      await TestBed.inject(ApplicationRef).whenStable();
      await update;
      expect(invoke).toHaveBeenCalledWith('update_backend', {
        params: {
          name: 'Local',
          host: localBackend.host,
          port: localBackend.port,
          isLocal: true,
          configPath,
        },
      });
    }
  );

  it('waits for the local backend before repairing its port', async () => {
    let finish!: (value: BackendInfo[]) => void;
    invoke
      .mockResolvedValue([localBackend])
      .mockImplementationOnce(() => new Promise<BackendInfo[]>(resolve => (finish = resolve)));
    const service = TestBed.inject(BackendService);
    const update = service.updateLocalBackendPort(51901);
    TestBed.tick();
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalledWith('update_backend', expect.anything());

    finish([localBackend]);
    await TestBed.inject(ApplicationRef).whenStable();
    await update;
    expect(invoke).toHaveBeenCalledWith('update_backend', {
      params: {
        name: 'Local',
        host: localBackend.host,
        port: 51901,
        isLocal: true,
        configPath: localBackend.configPath,
      },
    });
  });

  it('does not update a missing local backend after an empty load', async () => {
    invoke.mockResolvedValue([]);
    const service = TestBed.inject(BackendService);
    const update = service.updateLocalBackendPort(51901);
    TestBed.tick();
    await TestBed.inject(ApplicationRef).whenStable();
    await update;
    expect(invoke).toHaveBeenCalledExactlyOnceWith('list_backends', undefined);
  });

  it('probes each remote backend once and leaves Local to the engine', async () => {
    invoke.mockImplementation((command: string, args?: { name: string }) => {
      if (command === 'list_backends') {
        return Promise.resolve([
          localBackend,
          { ...localBackend, name: 'NAS & 旅行', isLocal: false, isActive: false },
          { ...localBackend, name: 'Offline', isLocal: false, isActive: false },
        ]);
      }
      if (args?.name === 'Offline') return Promise.reject(new Error('offline'));
      return Promise.resolve({
        success: true,
        version: 'v1.73.0',
        os: 'linux',
        config_path: '/etc/rclone.conf',
      });
    });
    const service = TestBed.inject(BackendService);
    await service.loadBackends();

    await service.refreshStatuses();

    const tested = invoke.mock.calls
      .filter(([command]) => command === 'test_backend_connection')
      .map(([, args]) => args.name);
    expect(tested.sort()).toEqual(['NAS & 旅行', 'Offline']);
    expect(service.backends().find(b => b.name === 'NAS & 旅行')).toMatchObject({
      status: { type: 'connected' },
      version: 'v1.73.0',
      os: 'linux',
      runtimeConfigPath: '/etc/rclone.conf',
    });
    expect(service.backends().find(b => b.name === 'Offline')?.status).toEqual({
      type: 'error',
      message: 'offline',
    });
  });

  it('keeps the last known version next to a failed test result', async () => {
    const nas: BackendInfo = {
      ...localBackend,
      name: 'NAS',
      isLocal: false,
      isActive: false,
      version: 'v1.70.0',
      os: 'linux',
      status: { type: 'connected' },
    };
    invoke.mockImplementation((command: string) =>
      command === 'list_backends'
        ? Promise.resolve([nas])
        : Promise.resolve({ success: false, message: 'Connection failed: refused' })
    );
    const service = TestBed.inject(BackendService);
    await service.loadBackends();

    const result = await service.testConnection('NAS');

    expect(result).toEqual({ success: false, message: 'Connection failed: refused' });
    expect(service.backends()[0]).toMatchObject({
      status: { type: 'error', message: 'Connection failed: refused' },
      version: 'v1.70.0',
      os: 'linux',
    });
  });

  it('reports a rejected test command as a failed result', async () => {
    invoke.mockRejectedValue(new Error('transport down'));
    const service = TestBed.inject(BackendService);

    await expect(
      service.testConnectionDetails({ host: 'nas', port: 51900, name: 'NAS' })
    ).resolves.toEqual({ success: false, message: 'transport down' });
    expect(invoke).toHaveBeenCalledWith('test_backend_connection_details', {
      host: 'nas',
      port: 51900,
      username: null,
      password: null,
      name: 'NAS',
    });
  });

  it('probes a saved remote after reloading the list, but not Local', async () => {
    invoke.mockImplementation((command: string) =>
      command === 'list_backends'
        ? Promise.resolve([localBackend])
        : Promise.resolve({ success: true })
    );
    const service = TestBed.inject(BackendService);

    await service.addBackend({ name: 'NAS', host: 'nas', port: 51900, isLocal: false });
    await service.updateBackend({ name: 'Local', host: 'h', port: 51900, isLocal: true });

    const commands = invoke.mock.calls.map(([command, args]) => [command, args?.name]);
    expect(commands).toEqual([
      ['add_backend', undefined],
      ['list_backends', undefined],
      ['test_backend_connection', 'NAS'],
      ['update_backend', undefined],
      ['list_backends', undefined],
    ]);
  });

  it('maps the form so an empty password means "keep" only when editing', () => {
    const service = TestBed.inject(BackendService);
    const form = {
      name: 'ignored',
      host: 'nas',
      port: '51900',
      has_auth: true,
      username: 'admin',
      password: '',
    };
    expect(service.mapFormToConfig(form, false, 'NAS')).toMatchObject({
      name: 'NAS',
      port: 51900,
      username: 'admin',
      password: undefined,
    });
    expect(service.mapFormToConfig({ ...form, has_auth: false }, false)).toMatchObject({
      name: 'ignored',
      username: '',
      password: '',
    });
  });

  it('sends the chosen copy source of each settings group and leaves the others out', async () => {
    invoke.mockResolvedValue([localBackend]);
    const service = TestBed.inject(BackendService);

    await service.addBackend({
      name: 'NAS',
      host: '10.0.0.5',
      port: 5572,
      isLocal: false,
      copyRemotesFrom: 'Local',
      copyFlowFrom: 'Local',
    });

    const call = invoke.mock.calls.find(([command]) => command === 'add_backend');
    expect(call?.[1]).toEqual({
      params: expect.objectContaining({
        name: 'NAS',
        copyRemotesFrom: 'Local',
        copyFlowFrom: 'Local',
      }),
    });
    expect(call?.[1].params.copyBackendFrom).toBeUndefined();
  });
});
