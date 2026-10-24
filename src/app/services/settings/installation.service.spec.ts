import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Subject } from 'rxjs';
import { InstallationService } from './installation.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { NotificationService } from '../ui/notification.service';
import { TranslateService } from '@ngx-translate/core';
import { BackendTranslationService } from '../i18n/backend-translation.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { ProvisionProgressPayload } from '@app/types';

describe('InstallationService', () => {
  let service: InstallationService;
  let apiClientMock: { invoke: ReturnType<typeof vi.fn> };
  let notificationMock: {
    showSuccess: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
  };
  let translateMock: { instant: ReturnType<typeof vi.fn> };
  let backendTranslationMock: { translateBackendMessage: ReturnType<typeof vi.fn> };
  let eventListenersMock: {
    listenToProvisionProgress: ReturnType<typeof vi.fn>;
  };
  let provisionProgress$: Subject<ProvisionProgressPayload>;

  beforeEach(() => {
    provisionProgress$ = new Subject<ProvisionProgressPayload>();
    apiClientMock = { invoke: vi.fn().mockResolvedValue(null) };
    notificationMock = { showSuccess: vi.fn(), showError: vi.fn() };
    translateMock = { instant: vi.fn((key: string) => key) };
    backendTranslationMock = {
      translateBackendMessage: vi.fn((err: unknown) => String(err)),
    };
    eventListenersMock = {
      listenToProvisionProgress: vi.fn().mockReturnValue(provisionProgress$.asObservable()),
    };

    TestBed.configureTestingModule({
      providers: [
        InstallationService,
        { provide: ApiClientService, useValue: apiClientMock },
        { provide: NotificationService, useValue: notificationMock },
        { provide: TranslateService, useValue: translateMock },
        { provide: BackendTranslationService, useValue: backendTranslationMock },
        { provide: EventListenersService, useValue: eventListenersMock },
      ],
    });

    service = TestBed.inject(InstallationService);
    apiClientMock.invoke.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('isMountPluginInstalled', () => {
    it('should return true when check_mount_plugin_installed succeeds with true', async () => {
      apiClientMock.invoke.mockResolvedValueOnce(true);

      const result = await service.isMountPluginInstalled();

      expect(result).toBe(true);
      expect(apiClientMock.invoke).toHaveBeenCalledWith('check_mount_plugin_installed', undefined);
    });

    it('should return false when check_mount_plugin_installed succeeds with false', async () => {
      apiClientMock.invoke.mockResolvedValueOnce(false);

      const result = await service.isMountPluginInstalled();

      expect(result).toBe(false);
      expect(apiClientMock.invoke).toHaveBeenCalledWith('check_mount_plugin_installed', undefined);
    });

    it('should return true without error notification if check_mount_plugin_installed fails or is not available', async () => {
      apiClientMock.invoke.mockRejectedValueOnce(new Error('Command not found'));

      const result = await service.isMountPluginInstalled();

      expect(result).toBe(true);
      expect(notificationMock.showError).not.toHaveBeenCalled();
    });
  });

  describe('installMountPlugin', () => {
    it('should invoke install_mount_plugin with notifications and reset progress', async () => {
      apiClientMock.invoke.mockResolvedValueOnce('installed');

      const result = await service.installMountPlugin();

      expect(result).toBe('installed');
      expect(apiClientMock.invoke).toHaveBeenCalledWith('install_mount_plugin', undefined);
      expect(notificationMock.showSuccess).toHaveBeenCalled();
      expect(service.mountPluginProgress()).toBeNull();
    });
  });

  describe('cancelMountPluginInstall', () => {
    it('should invoke cancel_mount_plugin_install and reset progress', async () => {
      apiClientMock.invoke.mockResolvedValueOnce(undefined);

      await service.cancelMountPluginInstall();

      expect(apiClientMock.invoke).toHaveBeenCalledWith('cancel_mount_plugin_install', undefined);
      expect(service.mountPluginProgress()).toBeNull();
    });
  });

  describe('rclone installation', () => {
    it('should invoke provision_rclone on installRclone', async () => {
      apiClientMock.invoke.mockResolvedValueOnce('installed');

      const result = await service.installRclone('/custom/path');

      expect(result).toBe('installed');
      expect(apiClientMock.invoke).toHaveBeenCalledWith('provision_rclone', {
        path: '/custom/path',
      });
      expect(service.rcloneProgress()).toBeNull();
    });

    it('should invoke cancel_provision_rclone on cancelRcloneInstall', async () => {
      apiClientMock.invoke.mockResolvedValueOnce(undefined);

      await service.cancelRcloneInstall();

      expect(apiClientMock.invoke).toHaveBeenCalledWith('cancel_provision_rclone', undefined);
      expect(service.rcloneProgress()).toBeNull();
    });
  });

  describe('provision progress listener', () => {
    it('should update rcloneProgress signal for Rclone component', () => {
      const payload: ProvisionProgressPayload = {
        component: 'rclone',
        stage: 'downloading',
        downloadedBytes: 1024,
        totalBytes: 2048,
      };

      provisionProgress$.next(payload);

      expect(service.rcloneProgress()).toEqual(payload);
      expect(service.mountPluginProgress()).toBeNull();
    });

    it('should update mountPluginProgress signal for MountPlugin component', () => {
      const payload: ProvisionProgressPayload = {
        component: 'mountPlugin',
        stage: 'installing',
        downloadedBytes: 512,
        totalBytes: 512,
      };

      provisionProgress$.next(payload);

      expect(service.mountPluginProgress()).toEqual(payload);
      expect(service.rcloneProgress()).toBeNull();
    });
  });
});
