import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { MatBottomSheet, MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { of, Subject } from 'rxjs';

import { SystemHealthService } from './system-health.service';
import { SystemInfoService } from '../system/system-info.service';
import { InstallationService } from '../../settings/installation.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { RclonePasswordService } from '../../security/rclone-password.service';
import { EventListenersService } from '../system/event-listeners.service';
import { BackendService } from '../system/backend.service';
import { RepairSheetType, SettingMetadata } from '@app/types';

describe('SystemHealthService', () => {
  let service: SystemHealthService;
  let systemInfoMock: { isRcloneAvailable: ReturnType<typeof vi.fn> };
  let installationMock: { isMountPluginInstalled: ReturnType<typeof vi.fn> };
  let appSettingsMock: {
    selectSetting: ReturnType<typeof vi.fn>;
    getSettingValue: ReturnType<typeof vi.fn>;
  };
  let rclonePasswordMock: {
    isConfigEncrypted: ReturnType<typeof vi.fn>;
    getStoredPassword: ReturnType<typeof vi.fn>;
    validatePassword: ReturnType<typeof vi.fn>;
    setConfigPasswordEnv: ReturnType<typeof vi.fn>;
  };
  let eventListenersMock: {
    listenToRcloneEngineReady: ReturnType<typeof vi.fn>;
    listenToRcloneEnginePathError: ReturnType<typeof vi.fn>;
    listenToRcloneEngineVersionError: ReturnType<typeof vi.fn>;
    listenToRcloneEnginePasswordError: ReturnType<typeof vi.fn>;
    listenToRcloneEngineAuthError: ReturnType<typeof vi.fn>;
    listenToRcloneEnginePortError: ReturnType<typeof vi.fn>;
    listenToMountPluginInstalled: ReturnType<typeof vi.fn>;
  };
  let backendMock: {
    isLocalBackend: ReturnType<typeof vi.fn>;
  };
  let bottomSheetMock: {
    open: ReturnType<typeof vi.fn>;
  };

  let skipSettingSubject: Subject<SettingMetadata | undefined>;
  let mountPluginInstalledEvent: Subject<void>;

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    skipSettingSubject = new Subject<SettingMetadata | undefined>();
    mountPluginInstalledEvent = new Subject<void>();

    systemInfoMock = {
      isRcloneAvailable: vi.fn().mockResolvedValue(true),
    };

    installationMock = {
      isMountPluginInstalled: vi.fn().mockResolvedValue(true),
    };

    appSettingsMock = {
      selectSetting: vi.fn().mockReturnValue(skipSettingSubject.asObservable()),
      getSettingValue: vi.fn().mockResolvedValue(false),
    };

    rclonePasswordMock = {
      isConfigEncrypted: vi.fn().mockResolvedValue(false),
      getStoredPassword: vi.fn().mockResolvedValue(null),
      validatePassword: vi.fn().mockResolvedValue(true),
      setConfigPasswordEnv: vi.fn().mockResolvedValue(undefined),
    };

    eventListenersMock = {
      listenToRcloneEngineReady: vi.fn().mockReturnValue(of(undefined)),
      listenToRcloneEnginePathError: vi.fn().mockReturnValue(of(undefined)),
      listenToRcloneEngineVersionError: vi.fn().mockReturnValue(of(undefined)),
      listenToRcloneEnginePasswordError: vi.fn().mockReturnValue(of(undefined)),
      listenToRcloneEngineAuthError: vi.fn().mockReturnValue(of({ message: 'auth error' })),
      listenToRcloneEnginePortError: vi.fn().mockReturnValue(of({ port: 51900, message: 'error' })),
      listenToMountPluginInstalled: vi
        .fn()
        .mockReturnValue(mountPluginInstalledEvent.asObservable()),
    };

    backendMock = {
      isLocalBackend: vi.fn().mockReturnValue(true),
    };

    bottomSheetMock = {
      open: vi.fn().mockReturnValue({
        afterDismissed: () => of(null),
        dismiss: vi.fn(),
        instance: {},
      } as unknown as MatBottomSheetRef<unknown>),
    };

    TestBed.configureTestingModule({
      providers: [
        SystemHealthService,
        { provide: SystemInfoService, useValue: systemInfoMock },
        { provide: InstallationService, useValue: installationMock },
        { provide: AppSettingsService, useValue: appSettingsMock },
        { provide: RclonePasswordService, useValue: rclonePasswordMock },
        { provide: EventListenersService, useValue: eventListenersMock },
        { provide: BackendService, useValue: backendMock },
        { provide: MatBottomSheet, useValue: bottomSheetMock },
      ],
    });

    service = TestBed.inject(SystemHealthService);
  });

  it('should initialize with default states and listen for skip_mount_plugin_check setting', () => {
    expect(service.rcloneInstalled()).toBeNull();
    expect(service.mountPluginInstalled()).toBeNull();
    expect(service.skipMountPluginCheck()).toBe(false);
    expect(appSettingsMock.selectSetting).toHaveBeenCalledWith('core.skip_mount_plugin_check');
  });

  it('should update skipMountPluginCheck signal when setting changes', () => {
    expect(service.skipMountPluginCheck()).toBe(false);

    skipSettingSubject.next({ value: true } as SettingMetadata);
    expect(service.skipMountPluginCheck()).toBe(true);

    skipSettingSubject.next({ value: false } as SettingMetadata);
    expect(service.skipMountPluginCheck()).toBe(false);
  });

  it('requires a password only for an encrypted config that is still locked', () => {
    service.configEncrypted.set(false);
    expect(service.passwordRequired()).toBe(false);
    service.configEncrypted.set(true);
    expect(service.passwordRequired()).toBe(true);
    service.markPasswordUnlocked();
    expect(service.passwordRequired()).toBe(false);
  });

  it('should treat isInitialized as true when mount plugin is skipped even if mountPluginInstalled is null', () => {
    service.rcloneInstalled.set(true);
    service.mountPluginInstalled.set(null);
    service.configEncrypted.set(false);

    service.setSkipMountPluginCheck(false);
    expect(service.isInitialized()).toBe(false);

    service.setSkipMountPluginCheck(true);
    expect(service.isInitialized()).toBe(true);
  });

  it('checkMountPlugin should still read the real state when skipped', async () => {
    service.setSkipMountPluginCheck(true);
    installationMock.isMountPluginInstalled.mockResolvedValueOnce(true);

    const result = await service.checkMountPlugin();

    expect(result).toBe(true);
    expect(service.mountPluginInstalled()).toBe(true);
    expect(installationMock.isMountPluginInstalled).toHaveBeenCalled();
  });

  it('checkMountPlugin should report a missing plugin even when skipped', async () => {
    service.setSkipMountPluginCheck(true);
    installationMock.isMountPluginInstalled.mockResolvedValueOnce(false);

    expect(await service.checkMountPlugin()).toBe(false);
    expect(service.mountPluginInstalled()).toBe(false);
  });

  it('checkMountPlugin should query installationService when not skipped', async () => {
    service.setSkipMountPluginCheck(false);
    installationMock.isMountPluginInstalled.mockResolvedValueOnce(true);

    const result = await service.checkMountPlugin();

    expect(result).toBe(true);
    expect(installationMock.isMountPluginInstalled).toHaveBeenCalled();
    expect(service.mountPluginInstalled()).toBe(true);
  });

  it('checkMountPluginAndPromptRepair should skip prompt when skipMountPluginCheck is true', async () => {
    service.setSkipMountPluginCheck(true);

    await service.checkMountPluginAndPromptRepair();

    expect(bottomSheetMock.open).not.toHaveBeenCalled();
  });

  it('checkMountPluginAndPromptRepair should still record a missing plugin when skipped, without prompting', async () => {
    service.setSkipMountPluginCheck(true);
    installationMock.isMountPluginInstalled.mockResolvedValueOnce(false);

    await service.checkMountPluginAndPromptRepair();

    expect(service.mountPluginInstalled()).toBe(false);
    expect(bottomSheetMock.open).not.toHaveBeenCalled();
  });

  describe('mount plugin installed event', () => {
    it('reports the plugin as missing only once the check found it missing', async () => {
      expect(service.mountPluginMissing()).toBe(false);
      installationMock.isMountPluginInstalled.mockResolvedValueOnce(false);

      await service.checkMountPlugin();

      expect(service.mountPluginMissing()).toBe(true);
    });

    it('clears the missing state when the plugin gets installed, with no start-up prompt before', async () => {
      vi.useFakeTimers();
      // Seen as missing without the start-up repair sheet: the check was skipped.
      service.setSkipMountPluginCheck(true);
      installationMock.isMountPluginInstalled.mockResolvedValueOnce(false);
      await service.checkMountPluginAndPromptRepair();
      expect(service.mountPluginMissing()).toBe(true);

      installationMock.isMountPluginInstalled.mockResolvedValueOnce(true);
      mountPluginInstalledEvent.next();
      await vi.advanceTimersByTimeAsync(1000);

      expect(service.mountPluginInstalled()).toBe(true);
      expect(service.mountPluginMissing()).toBe(false);
    });

    it('closes the open mount plugin repair sheet once the plugin is detected', async () => {
      vi.useFakeTimers();
      const dismiss = vi.fn();
      bottomSheetMock.open.mockReturnValueOnce({
        afterDismissed: () => new Subject().asObservable(),
        dismiss,
        instance: {},
      });
      await service.showRepairSheet({ type: RepairSheetType.MOUNT_PLUGIN });

      installationMock.isMountPluginInstalled.mockResolvedValueOnce(true);
      mountPluginInstalledEvent.next();
      await vi.advanceTimersByTimeAsync(1000);

      expect(dismiss).toHaveBeenCalled();
    });

    it('keeps the missing state when the event comes but the plugin is still not found', async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      installationMock.isMountPluginInstalled.mockResolvedValue(false);

      mountPluginInstalledEvent.next();
      await vi.advanceTimersByTimeAsync(1000);

      expect(service.mountPluginMissing()).toBe(true);
      warn.mockRestore();
    });

    it('listens once, however often the start-up check runs', async () => {
      installationMock.isMountPluginInstalled.mockResolvedValue(false);

      await service.checkMountPluginAndPromptRepair();
      await service.checkMountPluginAndPromptRepair();

      expect(eventListenersMock.listenToMountPluginInstalled).toHaveBeenCalledTimes(1);
    });
  });

  it('checkMountPluginAndPromptRepair should show repair sheet when plugin missing and not skipped', async () => {
    service.setSkipMountPluginCheck(false);
    appSettingsMock.getSettingValue.mockResolvedValueOnce(false);
    installationMock.isMountPluginInstalled.mockResolvedValueOnce(false);

    await service.checkMountPluginAndPromptRepair();

    expect(bottomSheetMock.open).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        data: { type: RepairSheetType.MOUNT_PLUGIN },
        disableClose: true,
      })
    );
  });
});
