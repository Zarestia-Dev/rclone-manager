import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { signal } from '@angular/core';
import { of } from 'rxjs';

import { AppDetailComponent } from './app-detail.component';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';
import { AutomationService } from 'src/app/services/operations/automation.service';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { SystemHealthService } from 'src/app/services/infrastructure/maintenance/system-health.service';
import { ModalService } from 'src/app/services/ui/modal.service';
import { LocalStorageService } from 'src/app/services/ui/state/local-storage.service';
import { FormatFileSizePipe, FormatTimePipe } from '@app/pipes';
import { MatDialog } from '@angular/material/dialog';
import { IconService } from 'src/app/services/ui/icon.service';
import { RepairSheetType, Remote, SettingMetadata } from '@app/types';

describe('AppDetailComponent - Mount Warning Banner', () => {
  let fixture: ComponentFixture<AppDetailComponent>;
  let component: AppDetailComponent;

  let remoteFacadeMock: {
    selectedRemote: ReturnType<typeof signal<Remote | null>>;
    isRemoteActive: ReturnType<typeof vi.fn>;
    activeInFlightActions: ReturnType<typeof signal<unknown[]>>;
    runningServes: ReturnType<typeof signal<unknown[]>>;
    mountedRemotes: ReturnType<typeof signal<unknown[]>>;
    stats: ReturnType<typeof signal<unknown>>;
    transfers: ReturnType<typeof signal<unknown[]>>;
    completedTransfers: ReturnType<typeof signal<unknown[]>>;
    updateRemoteSettings: ReturnType<typeof vi.fn>;
  };

  let jobServiceMock: {
    jobs: ReturnType<typeof signal<unknown[]>>;
  };

  let quickRunServiceMock: {
    runningIds: ReturnType<typeof signal<Set<string>>>;
    openEditor: ReturnType<typeof vi.fn>;
  };

  let automationServiceMock: {
    validateCron: ReturnType<typeof vi.fn>;
  };

  let appSettingsServiceMock: {
    options: ReturnType<typeof signal<Record<string, SettingMetadata>>>;
    saveSetting: ReturnType<typeof vi.fn>;
    selectSetting: ReturnType<typeof vi.fn>;
  };

  let systemHealthMock: {
    skipMountPluginCheck: ReturnType<typeof signal<boolean>>;
    mountPluginInstalled: ReturnType<typeof signal<boolean | null>>;
    showRepairSheet: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    remoteFacadeMock = {
      selectedRemote: signal<Remote | null>({
        name: 'test-remote',
        type: 'drive',
        status: { mount: { active: false } },
      } as unknown as Remote),
      isRemoteActive: vi.fn().mockReturnValue(true),
      activeInFlightActions: signal([]),
      runningServes: signal([]),
      mountedRemotes: signal([]),
      stats: signal(null),
      transfers: signal([]),
      completedTransfers: signal([]),
      updateRemoteSettings: vi.fn().mockResolvedValue(undefined),
    };

    jobServiceMock = {
      jobs: signal([]),
    };

    quickRunServiceMock = {
      runningIds: signal(new Set<string>()),
      openEditor: vi.fn(),
    };

    automationServiceMock = {
      validateCron: vi.fn().mockResolvedValue({ isValid: false }),
    };

    appSettingsServiceMock = {
      options: signal<Record<string, SettingMetadata>>({}),
      saveSetting: vi.fn().mockResolvedValue(undefined),
      selectSetting: vi.fn().mockReturnValue(of({ value: false })),
    };

    systemHealthMock = {
      skipMountPluginCheck: signal(false),
      mountPluginInstalled: signal<boolean | null>(true),
      showRepairSheet: vi.fn(),
    };

    TestBed.configureTestingModule({
      imports: [AppDetailComponent],
      providers: [
        provideTranslateService(),
        FormatFileSizePipe,
        FormatTimePipe,
        { provide: RemoteFacadeService, useValue: remoteFacadeMock },
        { provide: JobManagementService, useValue: jobServiceMock },
        { provide: QuickRunService, useValue: quickRunServiceMock },
        { provide: AutomationService, useValue: automationServiceMock },
        { provide: AppSettingsService, useValue: appSettingsServiceMock },
        { provide: SystemHealthService, useValue: systemHealthMock },
        { provide: ModalService, useValue: { openRemoteConfig: vi.fn() } },
        {
          provide: LocalStorageService,
          useValue: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
        },
        { provide: MatDialog, useValue: { open: vi.fn() } },
        { provide: IconService, useValue: { getIconName: vi.fn().mockReturnValue('hard-drive') } },
      ],
    });

    fixture = TestBed.createComponent(AppDetailComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('mainOperationType', 'mount');
    fixture.componentRef.setInput('remoteSettings', { mountConfigs: {} });
  });

  it('should not show banner when operation is not mount', () => {
    fixture.componentRef.setInput('mainOperationType', 'sync');
    systemHealthMock.skipMountPluginCheck.set(true);

    expect(component.showMountPluginWarning()).toBe(false);
  });

  it('should not show banner when skipMountPluginCheck is false and plugin is installed', () => {
    fixture.componentRef.setInput('mainOperationType', 'mount');
    systemHealthMock.skipMountPluginCheck.set(false);
    systemHealthMock.mountPluginInstalled.set(true);

    expect(component.showMountPluginWarning()).toBe(false);
  });

  it('should show banner when skipMountPluginCheck is false but mountPluginInstalled is false', () => {
    fixture.componentRef.setInput('mainOperationType', 'mount');
    systemHealthMock.skipMountPluginCheck.set(false);
    systemHealthMock.mountPluginInstalled.set(false);

    expect(component.showMountPluginWarning()).toBe(true);
  });

  it('should show banner when on mount and skipMountPluginCheck is true and mount_warn defaults to true', () => {
    fixture.componentRef.setInput('mainOperationType', 'mount');
    systemHealthMock.skipMountPluginCheck.set(true);

    expect(component.showMountPluginWarning()).toBe(true);
  });

  it('should show banner in quickRun mode when operationType is mount and skipMountPluginCheck is true', () => {
    fixture.componentRef.setInput('mode', 'quickRun');
    fixture.componentRef.setInput('quickRun', {
      id: 'qr-1',
      name: 'Test Quick Run',
      operationType: 'mount',
      remoteName: 'my-remote',
    });
    systemHealthMock.skipMountPluginCheck.set(true);

    expect(component.showMountPluginWarning()).toBe(true);
  });

  it('should not show banner when mount_warn setting is false', () => {
    fixture.componentRef.setInput('mainOperationType', 'mount');
    systemHealthMock.skipMountPluginCheck.set(true);
    appSettingsServiceMock.options.set({
      'runtime.mount_warn': { value: false } as SettingMetadata,
    });

    expect(component.showMountPluginWarning()).toBe(false);
  });

  it('should not show banner when dismissed in current session and save setting to false', async () => {
    fixture.componentRef.setInput('mainOperationType', 'mount');
    systemHealthMock.skipMountPluginCheck.set(true);

    expect(component.showMountPluginWarning()).toBe(true);

    await component.dismissMountPluginWarning();

    expect(component.mountWarningDismissed()).toBe(true);
    expect(component.showMountPluginWarning()).toBe(false);
    expect(appSettingsServiceMock.saveSetting).toHaveBeenCalledWith('runtime', 'mount_warn', false);
  });

  it('should open mount plugin repair sheet on onInstallMountPlugin', () => {
    component.onInstallMountPlugin();

    expect(systemHealthMock.showRepairSheet).toHaveBeenCalledWith({
      type: RepairSheetType.MOUNT_PLUGIN,
    });
  });
});
