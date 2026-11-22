import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { computed, Signal, signal } from '@angular/core';
import { of } from 'rxjs';

import { JobInfo } from '@app/types';
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
import { ProfileRequest, UiStateService } from 'src/app/services/ui/state/ui-state.service';
import { FormatFileSizePipe, FormatTimePipe } from '@app/pipes';
import { MatDialog } from '@angular/material/dialog';
import { MatIconTestingModule } from '@angular/material/icon/testing';
import { IconService } from 'src/app/services/ui/icon.service';
import { SettingsPanelComponent } from '../../../../shared/detail-shared/settings-panel/settings-panel.component';
import {
  ActionState,
  Automation,
  MountedRemote,
  PathDisplayConfig,
  RepairSheetType,
  Remote,
  SettingMetadata,
} from '@app/types';

const automation = (overrides: Partial<Automation> = {}): Automation => ({
  id: 'scheduled-sync',
  automationType: 'sync',
  remoteName: 'test-remote',
  profileName: 'Default',
  backendName: 'Local',
  status: 'enabled',
  args: {
    source: 'automation',
    srcPaths: ['/src'],
    dstPaths: ['/dst'],
  },
  cronExpression: null,
  lastRun: null,
  nextRun: null,
  lastError: null,
  currentJobId: null,
  watchEnabled: false,
  watchDelay: 5,
  watchChangedOnly: false,
  runCount: 0,
  successCount: 0,
  failureCount: 0,
  stoppedCount: 0,
  ...overrides,
});

describe('AppDetailComponent', () => {
  let fixture: ComponentFixture<AppDetailComponent>;
  let component: AppDetailComponent;
  let uiStateMock: {
    profileRequest: ReturnType<typeof signal<ProfileRequest | null>>;
    clearProfileRequest: ReturnType<typeof vi.fn>;
  };

  let remoteFacadeMock: {
    selectedRemote: ReturnType<typeof signal<Remote | null>>;
    isRemoteMissing: ReturnType<typeof vi.fn>;
    actionInProgress: ReturnType<typeof signal<Record<string, ActionState[]>>>;
    activeInFlightActions: ReturnType<typeof signal<unknown[]>>;
    runningServes: ReturnType<typeof signal<unknown[]>>;
    mountedRemotes: ReturnType<typeof signal<MountedRemote[]>>;
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
    actionInProgress: ReturnType<typeof signal<Record<string, 'start' | 'stop'>>>;
    openEditor: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
  };

  let automationServiceMock: {
    automations: ReturnType<typeof signal<Automation[]>>;
    toggleAutomation: ReturnType<typeof vi.fn>;
    validateCron: ReturnType<typeof vi.fn>;
  };
  const activeBackend = signal('Local');

  let appSettingsServiceMock: {
    isTrayAvailable: ReturnType<typeof signal<boolean>>;
    options: ReturnType<typeof signal<Record<string, SettingMetadata>>>;
    saveSetting: ReturnType<typeof vi.fn>;
    selectSetting: ReturnType<typeof vi.fn>;
  };

  let systemHealthMock: {
    skipMountPluginCheck: ReturnType<typeof signal<boolean>>;
    mountPluginInstalled: ReturnType<typeof signal<boolean | null>>;
    mountPluginMissing: Signal<boolean>;
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
      isRemoteMissing: vi.fn().mockReturnValue(false),
      actionInProgress: signal({}),
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
      actionInProgress: signal({}),
      openEditor: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    };

    automationServiceMock = {
      automations: signal<Automation[]>([]),
      toggleAutomation: vi.fn().mockResolvedValue(undefined),
      validateCron: vi.fn().mockResolvedValue({ isValid: false }),
    };

    appSettingsServiceMock = {
      isTrayAvailable: signal(true),
      options: signal<Record<string, SettingMetadata>>({}),
      saveSetting: vi.fn().mockResolvedValue(undefined),
      selectSetting: vi.fn().mockReturnValue(of({ value: false })),
    };

    uiStateMock = {
      profileRequest: signal<ProfileRequest | null>(null),
      clearProfileRequest: vi.fn(),
    };
    uiStateMock.clearProfileRequest.mockImplementation(() => uiStateMock.profileRequest.set(null));

    const mountPluginInstalled = signal<boolean | null>(true);
    systemHealthMock = {
      skipMountPluginCheck: signal(false),
      mountPluginInstalled,
      mountPluginMissing: computed(() => mountPluginInstalled() === false),
      showRepairSheet: vi.fn(),
    };

    TestBed.configureTestingModule({
      imports: [AppDetailComponent, MatIconTestingModule, SettingsPanelComponent],
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
        { provide: UiStateService, useValue: uiStateMock },
        { provide: ModalService, useValue: { openRemoteConfig: vi.fn(), openJobDetail: vi.fn() } },
        {
          provide: LocalStorageService,
          useValue: {
            get: vi.fn().mockReturnValue(null),
            set: vi.fn(),
            getScoped: vi.fn().mockReturnValue({}),
            setScoped: vi.fn(),
          },
        },
        { provide: MatDialog, useValue: { open: vi.fn() } },
        { provide: IconService, useValue: { getIconName: vi.fn().mockReturnValue('hard-drive') } },
      ],
    }).overrideComponent(AppDetailComponent, { set: { template: '', imports: [] } });

    fixture = TestBed.createComponent(AppDetailComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('mainOperationType', 'mount');
    fixture.componentRef.setInput('remoteSettings', { mountConfigs: {} });
  });

  it('shows each automatic mount in Monitoring and Configuration as its assigned drive changes', () => {
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('sk-SK', {
      wizards: { appOperation: { mountAutomaticDrive: 'Automaticky' } },
    });
    translate.use('sk-SK');
    const automatic = { app: {}, rclone: { mountPoint: '*' } };
    const nested = { app: {}, rclone: { mount: { mountPoint: '*' } } };
    const mountConfigs = { First: automatic, Second: nested };
    fixture.componentRef.setInput('remoteSettings', { mountConfigs });
    const updateMount = (activeProfiles: Record<string, string>): void => {
      remoteFacadeMock.selectedRemote.update(remote => {
        if (!remote) throw new Error('Missing test remote');
        return {
          ...remote,
          status: {
            ...remote.status,
            mount: { active: Object.keys(activeProfiles).length > 0, activeProfiles },
          },
        };
      });
    };
    const pathConfig = (): PathDisplayConfig => component.controlConfigs()[0].pathConfig;
    const panel = TestBed.createComponent(SettingsPanelComponent);
    const panelHost = panel.nativeElement as HTMLElement;
    const renderProfile = (name: string): string | undefined => {
      const section = component
        .operationSettingsSections()
        .find(item => item.key === `mount:${name}`);
      if (!section) throw new Error('Missing mount settings section');
      panel.componentRef.setInput('config', component.getSettingsPanelConfig(section));
      panel.componentInstance.isExpanded.set(true);
      panel.detectChanges();
      return panelHost.querySelector('.setting-value')?.textContent?.trim();
    };

    updateMount({ Second: 'y:/' });
    expect(pathConfig()).toMatchObject({
      destination: 'Automaticky',
      hasDestination: false,
      isDestinationActive: false,
    });
    expect(renderProfile('First')).toBe('Automaticky');
    expect(renderProfile('Second')).toBe('Automaticky · Y:');

    updateMount({ First: 'Z:', Second: 'y:/' });
    expect(pathConfig()).toMatchObject({
      destination: 'Z:',
      hasDestination: true,
      isDestinationActive: true,
    });
    expect(renderProfile('First')).toBe('Automaticky · Z:');
    component.onProfileSelect('Second');
    expect(pathConfig()).toMatchObject({ destination: 'Y:', isDestinationActive: true });

    updateMount({ First: 'Z:' });
    expect(pathConfig()).toMatchObject({
      destination: 'Automaticky',
      hasDestination: false,
      isDestinationActive: false,
    });
    expect(renderProfile('Second')).toBe('Automaticky');
    updateMount({ First: 'Z:', Second: 'X:' });
    expect(pathConfig()).toMatchObject({ destination: 'X:', isDestinationActive: true });
    expect(renderProfile('Second')).toBe('Automaticky · X:');
    const editSettings = vi.fn();
    panel.componentInstance.editSettings.subscribe(editSettings);
    panelHost.querySelector<HTMLButtonElement>('button.full-action-button')?.click();
    expect(editSettings).toHaveBeenCalledWith({
      section: 'mount:Second',
      settings: { app: {}, rclone: { mount: { mountPoint: '*' } } },
    });
  });

  it.each(['X:', 'D:\\Mounts\\Test'])('keeps the configured mount target %s', mountPoint => {
    fixture.componentRef.setInput('remoteSettings', {
      mountConfigs: { First: { app: {}, rclone: { mountPoint } } },
    });
    expect(component.controlConfigs()[0].pathConfig).toMatchObject({
      destination: mountPoint,
      hasDestination: true,
      isDestinationActive: false,
    });
    expect(
      component.getSettingsPanelConfig(component.operationSettingsSections()[0]).rcloneValueLabels
    ).toBeUndefined();
  });

  it('only uses the actual drive of the matching Quick Run', () => {
    fixture.componentRef.setInput('mode', 'quickRun');
    fixture.componentRef.setInput('quickRun', {
      id: 'qr-1',
      name: 'First',
      operationType: 'mount',
      remoteName: 'test-remote',
      config: { rclone: { mountPoint: '*' } },
    });
    quickRunServiceMock.runningIds.set(new Set(['qr-1']));
    const profileMount: MountedRemote = {
      fs: 'test-remote:',
      mount_point: 'Y:',
      starter: { kind: 'profile', name: 'First' },
    };
    remoteFacadeMock.mountedRemotes.set([profileMount]);
    expect(component.controlConfigs()[0].pathConfig).toMatchObject({
      destination: 'wizards.appOperation.mountAutomaticDrive',
      isDestinationActive: false,
    });

    remoteFacadeMock.mountedRemotes.set([
      profileMount,
      {
        fs: 'test-remote:',
        mount_point: 'Z:',
        starter: { kind: 'quick_run', id: 'qr-1', name: 'First' },
      },
    ]);
    expect(component.controlConfigs()[0].pathConfig).toMatchObject({
      destination: 'Z:',
      isDestinationActive: true,
    });
    expect(component.quickRunSettingsConfig().rcloneValueLabels?.get('mountPoint')).toBe(
      'wizards.appOperation.mountAutomaticDrive · Z:'
    );
  });

  describe('a profile another part of the app asks for', () => {
    const request = (extra: Partial<ProfileRequest> = {}): ProfileRequest => ({
      remoteName: 'test-remote',
      operationType: 'mount',
      profile: 'Second',
      ...extra,
    });

    it('opens that profile and takes the request', () => {
      fixture.componentRef.setInput('remoteSettings', {
        mountConfigs: { First: { app: {}, rclone: {} }, Second: { app: {}, rclone: {} } },
      });
      expect(component.selectedProfile()).toBe('First');
      uiStateMock.profileRequest.set(request());
      fixture.detectChanges();
      expect(component.selectedProfile()).toBe('Second');
      expect(uiStateMock.clearProfileRequest).toHaveBeenCalled();
    });

    it('switches to the operation of the profile on the operations tab', () => {
      fixture.componentRef.setInput('mainOperationType', 'operations');
      fixture.componentRef.setInput('remoteSettings', {
        syncConfigs: { Main: { app: {}, rclone: {} } },
        bisyncConfigs: { Daily: { app: {}, rclone: {} }, Notes: { app: {}, rclone: {} } },
      });
      uiStateMock.profileRequest.set(request({ operationType: 'bisync', profile: 'Notes' }));
      fixture.detectChanges();
      expect(component.selectedSyncOperation()).toBe('bisync');
      expect(component.selectedProfile()).toBe('Notes');
    });

    it('leaves a request for another remote alone', () => {
      uiStateMock.profileRequest.set(request({ remoteName: 'other' }));
      fixture.detectChanges();
      expect(uiStateMock.clearProfileRequest).not.toHaveBeenCalled();
      expect(uiStateMock.profileRequest()).not.toBeNull();
    });

    it('does not pick a profile of an operation the tab is not showing', () => {
      uiStateMock.profileRequest.set(request({ operationType: 'serve', profile: 'Share' }));
      fixture.detectChanges();
      expect(component.selectedProfile()).not.toBe('Share');
      expect(uiStateMock.clearProfileRequest).toHaveBeenCalled();
    });
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

  it('should hide the banner as soon as the plugin gets installed', () => {
    fixture.componentRef.setInput('mainOperationType', 'mount');
    systemHealthMock.mountPluginInstalled.set(false);
    expect(component.showMountPluginWarning()).toBe(true);

    systemHealthMock.mountPluginInstalled.set(true);

    expect(component.showMountPluginWarning()).toBe(false);
  });

  it('should not show banner when skipMountPluginCheck is true but the plugin is installed', () => {
    fixture.componentRef.setInput('mainOperationType', 'mount');
    systemHealthMock.skipMountPluginCheck.set(true);
    systemHealthMock.mountPluginInstalled.set(true);

    expect(component.showMountPluginWarning()).toBe(false);
  });

  it('should show banner when on mount, plugin is missing and mount_warn defaults to true', () => {
    fixture.componentRef.setInput('mainOperationType', 'mount');
    systemHealthMock.skipMountPluginCheck.set(true);
    systemHealthMock.mountPluginInstalled.set(false);

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
    systemHealthMock.mountPluginInstalled.set(false);

    expect(component.showMountPluginWarning()).toBe(true);
  });

  it('should not show banner when mount_warn setting is false', () => {
    fixture.componentRef.setInput('mainOperationType', 'mount');
    systemHealthMock.skipMountPluginCheck.set(true);
    systemHealthMock.mountPluginInstalled.set(false);
    appSettingsServiceMock.options.set({
      'runtime.mount_warn': { value: false } as SettingMetadata,
    });

    expect(component.showMountPluginWarning()).toBe(false);
  });

  it('should not show banner when dismissed in current session and save setting to false', async () => {
    fixture.componentRef.setInput('mainOperationType', 'mount');
    systemHealthMock.skipMountPluginCheck.set(true);
    systemHealthMock.mountPluginInstalled.set(false);

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

  it('opens the detail of the job on show, and nothing when there is none', () => {
    const modal = TestBed.inject(ModalService);
    component.onOpenJobDetail();
    expect(modal.openJobDetail).not.toHaveBeenCalled();

    const job = { jobid: 9, group: 'job/9' } as JobInfo;
    vi.spyOn(component, 'activeGroupJob').mockReturnValue(job);
    component.onOpenJobDetail();
    expect(modal.openJobDetail).toHaveBeenCalledWith(job);
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

  describe('file report', () => {
    const profile = (rclone: Record<string, unknown>): void => {
      fixture.componentRef.setInput('mainOperationType', 'sync');
      fixture.componentRef.setInput('remoteSettings', {
        syncConfigs: { Default: { app: {}, rclone: { srcFs: 'test-remote:', ...rclone } } },
      });
    };

    it('is on when the profile asks for any report', () => {
      profile({});
      expect(component.isFileReport()).toBe(false);
      profile({ differ: true });
      expect(component.isFileReport()).toBe(true);
    });

    it('turns the combined report on for the profile and keeps its other options', async () => {
      profile({ createEmptySrcDirs: true });
      await component.toggleFileReport();
      expect(remoteFacadeMock.updateRemoteSettings).toHaveBeenCalledWith('test-remote', {
        syncConfigs: {
          Default: {
            app: {},
            rclone: { srcFs: 'test-remote:', createEmptySrcDirs: true, combined: true },
          },
        },
      });
    });

    it('turns every report off for the profile', async () => {
      profile({ combined: true, differ: true, match: true });
      await component.toggleFileReport();
      expect(remoteFacadeMock.updateRemoteSettings).toHaveBeenCalledWith('test-remote', {
        syncConfigs: { Default: { app: {}, rclone: { srcFs: 'test-remote:' } } },
      });
    });

    it('lists the reports the profile asks for, in the order the report view uses', () => {
      profile({ differ: true, combined: true, match: false, destAfter: true });
      expect(component.activeReports()).toEqual(['combined', 'differ', 'destAfter']);
    });

    it('turns a single report on or off without touching the others', async () => {
      profile({ combined: true });
      await component.toggleReport('differ');
      expect(remoteFacadeMock.updateRemoteSettings).toHaveBeenLastCalledWith('test-remote', {
        syncConfigs: {
          Default: { app: {}, rclone: { srcFs: 'test-remote:', combined: true, differ: true } },
        },
      });

      profile({ combined: true, differ: true });
      await component.toggleReport('differ');
      expect(remoteFacadeMock.updateRemoteSettings).toHaveBeenLastCalledWith('test-remote', {
        syncConfigs: { Default: { app: {}, rclone: { srcFs: 'test-remote:', combined: true } } },
      });
    });

    it('is not offered for operations that keep no report', async () => {
      fixture.componentRef.setInput('mainOperationType', 'bisync');
      fixture.componentRef.setInput('remoteSettings', {
        bisyncConfigs: { Default: { app: {}, rclone: { combined: true } } },
      });
      expect(component.isFileReport()).toBe(false);
      await component.toggleFileReport();
      expect(remoteFacadeMock.updateRemoteSettings).not.toHaveBeenCalled();
    });

    it('is saved on the Quick Run in Quick Run mode', async () => {
      const quickRun = {
        id: 'qr-1',
        name: 'Run',
        remoteName: 'test-remote',
        operationType: 'sync',
        config: { app: {}, rclone: { srcFs: 'a:', dstFs: 'b:' } },
      };
      fixture.componentRef.setInput('mode', 'quickRun');
      fixture.componentRef.setInput('quickRun', quickRun);
      fixture.componentRef.setInput('mainOperationType', 'sync');
      expect(component.isFileReport()).toBe(false);
      await component.toggleFileReport();
      expect(quickRunServiceMock.save).toHaveBeenCalledWith({
        ...quickRun,
        config: { app: {}, rclone: { srcFs: 'a:', dstFs: 'b:', combined: true } },
      });
      expect(remoteFacadeMock.updateRemoteSettings).not.toHaveBeenCalled();
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
        automation({ args: { ...managed.args, source: 'workflow' } }),
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
