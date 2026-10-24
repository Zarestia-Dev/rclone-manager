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
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { SystemHealthService } from 'src/app/services/infrastructure/maintenance/system-health.service';
import { ModalService } from 'src/app/services/ui/modal.service';
import { LocalStorageService } from 'src/app/services/ui/state/local-storage.service';
import { FormatFileSizePipe, FormatTimePipe } from '@app/pipes';
import { MatDialog } from '@angular/material/dialog';
import { IconService } from 'src/app/services/ui/icon.service';
import { Automation, RepairSheetType, Remote, SettingMetadata } from '@app/types';

const automation = (overrides: Partial<Automation> = {}): Automation => ({
  id: 'scheduled-sync',
  automationType: 'sync',
  remoteName: 'test-remote',
  profileName: 'Default',
  backendName: 'Local',
  status: 'enabled',
  args: {
    remoteName: 'test-remote',
    profileName: 'Default',
    source: 'automation',
    srcPaths: ['/src'],
    dstPaths: ['/dst'],
  },
  createdAt: '2026-01-01T00:00:00Z',
  runCount: 0,
  successCount: 0,
  failureCount: 0,
  stoppedCount: 0,
  ...overrides,
});

describe('AppDetailComponent', () => {
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
    getRemote: ReturnType<typeof vi.fn>;
  };

  let jobServiceMock: {
    jobs: ReturnType<typeof signal<unknown[]>>;
    getLatestJobForQuickRun: ReturnType<typeof vi.fn>;
    getLatestJobForRemote: ReturnType<typeof vi.fn>;
  };

  let quickRunServiceMock: {
    runningIds: ReturnType<typeof signal<Set<string>>>;
    openEditor: ReturnType<typeof vi.fn>;
  };

  let automationServiceMock: {
    automations: ReturnType<typeof signal<Automation[]>>;
    toggleAutomation: ReturnType<typeof vi.fn>;
    validateCron: ReturnType<typeof vi.fn>;
  };
  const activeBackend = signal('Local');

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
    activeBackend.set('Local');
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
      getRemote: vi.fn(),
    };

    jobServiceMock = {
      jobs: signal([]),
      getLatestJobForQuickRun: vi.fn().mockReturnValue(null),
      getLatestJobForRemote: vi.fn().mockReturnValue(null),
    };

    quickRunServiceMock = {
      runningIds: signal(new Set<string>()),
      openEditor: vi.fn(),
    };

    automationServiceMock = {
      automations: signal<Automation[]>([]),
      toggleAutomation: vi.fn().mockResolvedValue(undefined),
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
        { provide: BackendService, useValue: { activeBackend } },
        { provide: AppSettingsService, useValue: appSettingsServiceMock },
        { provide: SystemHealthService, useValue: systemHealthMock },
        { provide: ModalService, useValue: { openRemoteConfig: vi.fn() } },
        {
          provide: LocalStorageService,
          useValue: {
            get: vi.fn().mockReturnValue(null),
            set: vi.fn(),
            getScoped: vi.fn().mockReturnValue({}),
          },
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

  it('reads and toggles dry run in Default when the backend profile reference is omitted', async () => {
    fixture.componentRef.setInput('mainOperationType', 'sync');
    fixture.componentRef.setInput('remoteSettings', {
      syncConfigs: { Default: { app: {}, rclone: { srcFs: 'test-remote:', dstFs: '/tmp' } } },
      backendConfigs: { Default: { dry_run: true, transfers: 8 } },
    });
    expect(component.isDryRun()).toBe(true);
    await component.toggleDryRun();
    expect(remoteFacadeMock.updateRemoteSettings).toHaveBeenCalledWith('test-remote', {
      backendConfigs: { Default: { dry_run: false, transfers: 8 } },
    });
  });

  describe('runtime automation display', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('mainOperationType', 'sync');
      fixture.componentRef.setInput('remoteSettings', {
        syncConfigs: {
          Default: {
            app: {
              cronEnabled: true,
              cronExpression: '0 1 * * *',
              watchEnabled: true,
              watchDelay: 99,
            },
          },
        },
      });
    });

    it('does not display configured schedules or invent a next run without a managed automation', () => {
      expect(component.matchingAutomation()).toBeUndefined();
      expect(component.selectedCronSchedule()).toBeNull();
      expect(component.selectedWatcher()).toBeNull();
      expect(component.hasActiveAutomations()).toBe(false);
      expect(component.nextRunFormatted()).toBeNull();
      expect(automationServiceMock.validateCron).not.toHaveBeenCalled();
      expect(component.enrichedProfiles()[0]).toMatchObject({
        status: 'idle',
        hasSchedule: false,
        hasWatcher: false,
      });
    });

    it('uses manager values and reacts to updates and removal', () => {
      const nextRun = '2026-01-02T02:00:00Z';
      const managed = automation({
        cronExpression: '0 2 * * *',
        watchEnabled: true,
        watchDelay: 0,
        watchChangedOnly: true,
        nextRun,
      });
      automationServiceMock.automations.set([managed]);
      expect(component.selectedCronSchedule()?.cronExpression).toBe(managed.cronExpression);
      expect(component.selectedWatcher()).toEqual({
        profileName: 'Default',
        watchDelay: 0,
        watchChangedOnly: true,
      });
      expect(component.nextRunFormatted()).toBe(new Date(nextRun).toLocaleString());
      expect(component.enrichedProfiles()[0]).toMatchObject({
        status: 'scheduled',
        hasSchedule: true,
        hasWatcher: true,
      });
      automationServiceMock.automations.set([automation()]);
      expect(component.selectedCronSchedule()).toBeNull();
      expect(component.selectedWatcher()).toBeNull();
      expect(component.nextRunFormatted()).toBeNull();
      automationServiceMock.automations.set([]);
      expect(component.matchingAutomation()).toBeUndefined();
    });

    it('matches backend, remote, operation, origin and profile name exactly', () => {
      const managed = automation();
      const otherBackend = automation({ id: 'other-backend', backendName: 'Other' });
      automationServiceMock.automations.set([
        otherBackend,
        automation({ remoteName: 'other-remote' }),
        automation({ automationType: 'copy' }),
        automation({ profileName: 'default' }),
        automation({ args: { ...managed.args, source: 'quickrun' } }),
        automation({ args: { ...managed.args, source: 'flow' } }),
        managed,
      ]);
      expect(component.matchingAutomation()).toBe(managed);
      activeBackend.set('Other');
      expect(component.matchingAutomation()).toBe(otherBackend);
    });

    it('uses the exact Quick Run ID instead of a partial ID match', () => {
      fixture.componentRef.setInput('mode', 'quickRun');
      fixture.componentRef.setInput('quickRun', {
        id: 'qr-1',
        name: 'Run',
        remoteName: 'test-remote',
        operationType: 'sync',
        config: { app: {}, rclone: {} },
      });
      const managed = automation({
        id: 'qr-1',
        cronExpression: '0 3 * * *',
        args: { ...automation().args, source: 'quickrun' },
      });
      automationServiceMock.automations.set([automation({ id: 'prefix-qr-1' }), managed]);
      expect(component.matchingAutomation()).toBe(managed);
      expect(component.selectedCronSchedule()?.cronExpression).toBe('0 3 * * *');
    });

    it('toggles the managed automation and respects disabled and stopping states', async () => {
      automationServiceMock.automations.set([
        automation({
          status: 'disabled',
          cronExpression: '0 2 * * *',
          nextRun: '2026-01-02T02:00:00Z',
        }),
      ]);
      expect(component.isAutomationDisabled()).toBe(true);
      expect(component.selectedCronSchedule()).not.toBeNull();
      expect(component.nextRunFormatted()).toBeNull();
      expect(component.enrichedProfiles()[0].status).toBe('idle');
      await component.onToggleAutomation();
      expect(automationServiceMock.toggleAutomation).toHaveBeenCalledExactlyOnceWith(
        'scheduled-sync'
      );
      automationServiceMock.automations.set([automation({ status: 'stopping' })]);
      expect(component.isAutomationStopping()).toBe(true);
      await component.onToggleAutomation();
      expect(automationServiceMock.toggleAutomation).toHaveBeenCalledTimes(1);
    });

    it('keeps autostart as a startup setting independently of the scheduler', () => {
      fixture.componentRef.setInput('remoteSettings', {
        syncConfigs: { Default: { app: { autoStart: true } } },
      });
      expect(component.isAutoStartEnabled()).toBe(true);
      expect(component.selectedCronSchedule()).toBeNull();
      expect(component.selectedWatcher()).toBeNull();
    });
  });
});
