import { TestBed, ComponentFixture } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { provideTranslateService } from '@ngx-translate/core';

import { OnboardingComponent } from './onboarding.component';
import { InstallationService } from 'src/app/services/settings/installation.service';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { EventListenersService } from 'src/app/services/infrastructure/system/event-listeners.service';
import { RclonePasswordService } from 'src/app/services/security/rclone-password.service';
import { SystemHealthService } from 'src/app/services/infrastructure/maintenance/system-health.service';
import { BackupRestoreUiService } from 'src/app/services/settings/backup-restore-ui.service';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';
import { BackendService } from '../../services/infrastructure/system/backend.service';

describe('OnboardingComponent', () => {
  let fixture: ComponentFixture<OnboardingComponent>;
  let component: OnboardingComponent;

  let installationServiceMock: {
    rcloneProgress: ReturnType<typeof signal>;
    mountPluginProgress: ReturnType<typeof signal>;
    installRclone: ReturnType<typeof vi.fn>;
    cancelRcloneInstall: ReturnType<typeof vi.fn>;
    installMountPlugin: ReturnType<typeof vi.fn>;
    cancelMountPluginInstall: ReturnType<typeof vi.fn>;
  };

  let appSettingsServiceMock: {
    getSettingValue: ReturnType<typeof vi.fn>;
    saveSetting: ReturnType<typeof vi.fn>;
  };

  let eventListenersServiceMock: {
    listenToRcloneEngineReady: ReturnType<typeof vi.fn>;
    listenToBrowse: ReturnType<typeof vi.fn>;
    listenToRemoteCacheUpdated: ReturnType<typeof vi.fn>;
    listenToRemoteSettingsChanged: ReturnType<typeof vi.fn>;
    listenToBackendSwitched: ReturnType<typeof vi.fn>;
  };

  let rclonePasswordServiceMock: {
    validatePassword: ReturnType<typeof vi.fn>;
    setConfigPasswordEnv: ReturnType<typeof vi.fn>;
    storePassword: ReturnType<typeof vi.fn>;
  };

  let backendServiceMock: {
    updateLocalBackendConfigPath: ReturnType<typeof vi.fn>;
  };

  let backupRestoreUiServiceMock: {
    launchRestoreFlow: ReturnType<typeof vi.fn>;
  };

  let uiStateServiceMock: {
    setDefaultView: ReturnType<typeof vi.fn>;
  };

  let systemHealthMock: {
    isInitialized: ReturnType<typeof signal<boolean>>;
    rcloneInstalled: ReturnType<typeof signal<boolean>>;
    mountPluginInstalled: ReturnType<typeof signal<boolean>>;
    passwordRequired: ReturnType<typeof signal<boolean>>;
    runAllChecks: ReturnType<typeof vi.fn>;
    markRcloneInstalled: ReturnType<typeof vi.fn>;
    checkMountPlugin: ReturnType<typeof vi.fn>;
    checkConfigEncryption: ReturnType<typeof vi.fn>;
    markPasswordUnlocked: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    installationServiceMock = {
      rcloneProgress: signal(null),
      mountPluginProgress: signal(null),
      installRclone: vi.fn().mockResolvedValue(undefined),
      cancelRcloneInstall: vi.fn().mockResolvedValue(undefined),
      installMountPlugin: vi.fn().mockResolvedValue(undefined),
      cancelMountPluginInstall: vi.fn().mockResolvedValue(undefined),
    };

    appSettingsServiceMock = {
      getSettingValue: vi.fn().mockResolvedValue('main_menu'),
      saveSetting: vi.fn().mockResolvedValue(undefined),
    };

    eventListenersServiceMock = {
      listenToRcloneEngineReady: vi.fn().mockReturnValue(of(undefined)),
      listenToBrowse: vi.fn().mockReturnValue(of('')),
      listenToRemoteCacheUpdated: vi.fn().mockReturnValue(of(undefined)),
      listenToRemoteSettingsChanged: vi.fn().mockReturnValue(of(undefined)),
      listenToBackendSwitched: vi.fn().mockReturnValue(of(undefined)),
    };

    rclonePasswordServiceMock = {
      validatePassword: vi.fn().mockResolvedValue(true),
      setConfigPasswordEnv: vi.fn().mockResolvedValue(undefined),
      storePassword: vi.fn().mockResolvedValue(undefined),
    };

    backendServiceMock = {
      updateLocalBackendConfigPath: vi.fn().mockResolvedValue(undefined),
    };

    backupRestoreUiServiceMock = {
      launchRestoreFlow: vi.fn(),
    };

    uiStateServiceMock = {
      setDefaultView: vi.fn(),
    };

    systemHealthMock = {
      isInitialized: signal(true),
      rcloneInstalled: signal(true),
      mountPluginInstalled: signal(true),
      passwordRequired: signal(false),
      runAllChecks: vi.fn().mockResolvedValue(undefined),
      markRcloneInstalled: vi.fn(),
      checkMountPlugin: vi.fn().mockResolvedValue(undefined),
      checkConfigEncryption: vi.fn().mockResolvedValue(undefined),
      markPasswordUnlocked: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [OnboardingComponent],
      providers: [
        provideTranslateService(),
        { provide: InstallationService, useValue: installationServiceMock },
        { provide: AppSettingsService, useValue: appSettingsServiceMock },
        { provide: EventListenersService, useValue: eventListenersServiceMock },
        { provide: RclonePasswordService, useValue: rclonePasswordServiceMock },
        { provide: BackendService, useValue: backendServiceMock },
        { provide: BackupRestoreUiService, useValue: backupRestoreUiServiceMock },
        { provide: UiStateService, useValue: uiStateServiceMock },
        { provide: SystemHealthService, useValue: systemHealthMock },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(OnboardingComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('initializes component and loads default view setting', () => {
    expect(component).toBeTruthy();
    expect(systemHealthMock.runAllChecks).toHaveBeenCalled();
    expect(component.selectedMainUi()).toBe('main_menu');
  });

  it('filters cards dynamically based on system health states', () => {
    // When rclone is installed, mount plugin installed, no password required
    const initialKeys = component.cards().map(c => c.key);
    expect(initialKeys).not.toContain('installRclone');
    expect(initialKeys).not.toContain('installPlugin');
    expect(initialKeys).not.toContain('passwordRequired');

    // When rclone is missing
    systemHealthMock.rcloneInstalled.set(false);
    fixture.detectChanges();
    const withMissingRclone = component.cards().map(c => c.key);
    expect(withMissingRclone).toContain('installRclone');
  });

  it('navigates next and previous properly within bounds', () => {
    expect(component.currentCardIndex()).toBe(0);
    component.nextCard();
    expect(component.currentCardIndex()).toBe(1);

    component.previousCard();
    expect(component.currentCardIndex()).toBe(0);

    // Bounds: previous from 0 remains 0
    component.previousCard();
    expect(component.currentCardIndex()).toBe(0);
  });

  it('checks canNavigateToCard correctly', () => {
    // Navigating backwards or to current card is always allowed
    expect(component.canNavigateToCard(0)).toBe(true);

    // Cannot navigate out of range
    expect(component.canNavigateToCard(999)).toBe(false);

    // Navigating forward when unblocked
    expect(component.canNavigateToCard(1)).toBe(true);
  });

  it('selects main UI option correctly', () => {
    component.selectMainUiOption('nautilus');
    expect(component.selectedMainUi()).toBe('nautilus');

    component.selectMainUiOption('flow');
    expect(component.selectedMainUi()).toBe('flow');
  });

  it('cancels active install or plugin tasks', async () => {
    component.installing.set(true);
    await component.cancelActiveTask();
    expect(installationServiceMock.cancelRcloneInstall).toHaveBeenCalled();
    expect(component.installing()).toBe(false);

    component.downloadingPlugin.set(true);
    await component.cancelActiveTask();
    expect(installationServiceMock.cancelMountPluginInstall).toHaveBeenCalled();
    expect(component.downloadingPlugin()).toBe(false);
  });

  it('completes onboarding, saves settings, and emits completed', async () => {
    const emitSpy = vi.spyOn(component.completed, 'emit');
    component.selectMainUiOption('flow');

    await component.completeOnboarding();

    expect(appSettingsServiceMock.saveSetting).toHaveBeenCalledWith(
      'general',
      'default_view',
      'flow'
    );
    expect(uiStateServiceMock.setDefaultView).toHaveBeenCalledWith('flow');
    expect(emitSpy).toHaveBeenCalled();
  });

  it('opens import settings backup flow', () => {
    component.importSettings();
    expect(backupRestoreUiServiceMock.launchRestoreFlow).toHaveBeenCalled();
  });
});
