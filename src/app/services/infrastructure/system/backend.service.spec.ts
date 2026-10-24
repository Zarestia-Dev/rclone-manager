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
    password: 'password',
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
          useValue: { translateBackendMessage: (error: Error): string => error.message },
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
        params: expect.objectContaining({
          name: 'Local',
          host: localBackend.host,
          port: localBackend.port,
          username: localBackend.username,
          password: localBackend.password,
          configPath,
        }),
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
      params: expect.objectContaining({
        name: 'Local',
        host: localBackend.host,
        port: 51901,
        username: localBackend.username,
        password: localBackend.password,
        configPath: localBackend.configPath,
      }),
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

  it.each(['NAS & 旅行', 'Local', 'Missing active'])(
    'loads the list before checking each remote once with %s active',
    async activeName => {
      let finish!: (value: BackendInfo[]) => void;
      invoke.mockImplementation((command: string, args?: { name: string }) => {
        if (command === 'list_backends') {
          return new Promise<BackendInfo[]>(resolve => (finish = resolve));
        }
        if (command === 'get_active_backend') return Promise.resolve(activeName);
        if (args?.name === 'Offline') return Promise.reject(new Error('offline'));
        return Promise.resolve({ success: true, version: 'v1.73.0', os: 'linux' });
      });
      const service = TestBed.inject(BackendService);
      const checks = service.runStartupChecks();
      TestBed.tick();
      await Promise.resolve();
      expect(invoke).toHaveBeenCalledExactlyOnceWith('list_backends', undefined);

      finish([
        localBackend,
        { ...localBackend, name: 'NAS & 旅行', isLocal: false, isActive: false },
        { ...localBackend, name: 'Offline', isLocal: false, isActive: false },
      ]);
      await TestBed.inject(ApplicationRef).whenStable();
      await checks;

      const testedNames = invoke.mock.calls
        .filter(([command]) => command === 'test_backend_connection')
        .map(([, args]) => args.name);
      expect(testedNames.sort()).toEqual(
        (activeName === 'Missing active'
          ? ['Missing active', 'NAS & 旅行', 'Offline']
          : ['NAS & 旅行', 'Offline']
        ).sort()
      );
      expect(service.activeBackend()).toBe(activeName);
      expect(service.backends().find(b => b.name === 'NAS & 旅行')?.status).toEqual({
        type: 'connected',
      });
    }
  );
});
