import { TitleCasePipe } from '@angular/common';
import { Component, inject, computed, input, model, output, linkedSignal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslateService, TranslateModule } from '@ngx-translate/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDividerModule } from '@angular/material/divider';
import { MatButtonModule } from '@angular/material/button';
import { MatTabsModule } from '@angular/material/tabs';
import { FormatTimePipe, FormatFileSizePipe } from '@app/pipes';
import { CdkMenuModule } from '@angular/cdk/menu';
import {
  CompletedTransfer,
  GlobalStats,
  DEFAULT_JOB_STATS,
  JobInfo,
  JobInfoConfig,
  OperationColor,
  OperationControlConfig,
  PathDisplayConfig,
  PrimaryActionType,
  OperationTab,
  RemoteStatus,
  RemoteOperationState,
  RemoteServeState,
  RemoteAction,
  RemoteSettings,
  RemoteSettingsSection,
  ServeListItem,
  SettingsPanelConfig,
  StatsPanelConfig,
  SyncOperationViewModel,
  SyncOperationType,
  TransferActivityPanelConfig,
  TransferFile,
  REMOTE_CONFIG_KEYS,
  OPERATION_METADATA,
  ACTION_ANIMATION_CLASS,
  OPERATION_COLOR_VAR,
  SyncConfig,
  CopyConfig,
  MoveConfig,
  BisyncConfig,
  CheckConfig,
  DeleteConfig,
  CopyurlConfig,
  ArchivecreateConfig,
  ProfileConfig,
  JobStatsWithCompleted,
  StartJobEvent,
  StopJobEvent,
  ALL_PRIMARY_ACTIONS,
  SYNC_TYPES,
  STANDARD_MODAL_SIZE,
  MODE_DEFAULTS,
  BACKEND_PROFILE_SUPPORTED_OPS,
} from '@app/types';
import {
  JobInfoPanelComponent,
  OperationControlComponent,
  SettingsPanelComponent,
  StatsPanelComponent,
  TransferActivityPanelComponent,
} from '../../../../shared/detail-shared';
import { ServeCardComponent } from '../../../../shared/components/serve-card/serve-card.component';
import { IconService } from 'src/app/services/ui/icon.service';
import {
  JobManagementService,
  mapRawTransfer,
  mapCheckOutput,
} from 'src/app/services/operations/job-management.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { LocalStorageService } from 'src/app/services/ui/state/local-storage.service';
import { toString as cronstrue } from 'cronstrue';
import { VfsControlPanelComponent } from '../../../../shared/detail-shared/vfs-control/vfs-control-panel.component';
import { getCronstrueLocale } from 'src/app/services/i18n/cron-locale.mapper';
import { MatDialog } from '@angular/material/dialog';
import { ActionSelectionModalComponent } from 'src/app/features/modals/action-selection-modal/action-selection-modal.component';

@Component({
  selector: 'app-app-detail',
  standalone: true,
  imports: [
    TitleCasePipe,
    MatIconModule,
    MatTooltipModule,
    MatDividerModule,
    MatButtonModule,
    MatTabsModule,
    CdkMenuModule,
    OperationControlComponent,
    JobInfoPanelComponent,
    StatsPanelComponent,
    SettingsPanelComponent,
    TransferActivityPanelComponent,
    VfsControlPanelComponent,
    ServeCardComponent,
    TranslateModule,
  ],
  providers: [FormatFileSizePipe, FormatTimePipe],
  templateUrl: './app-detail.component.html',
  styleUrls: ['./app-detail.component.scss'],
})
export class AppDetailComponent {
  // --- Inputs ---
  readonly mainOperationType = input<OperationTab>('mount');
  readonly selectedSyncOperation = model<SyncOperationType>('sync');
  readonly remoteSettings = input<RemoteSettings>({});

  // --- Outputs ---
  readonly openRemoteConfigModal = output<{
    editTarget?: string;
    initialSection?: string;
    targetProfile?: string;
    remoteType?: string;
    autoAddProfile?: boolean;
  }>();
  readonly openInFiles = output<{ remoteName: string; path: string }>();
  readonly startJob = output<StartJobEvent>();
  readonly stopJob = output<StopJobEvent>();

  // --- Services ---
  private readonly remoteFacade = inject(RemoteFacadeService);
  private readonly jobService = inject(JobManagementService);
  protected readonly iconService = inject(IconService);
  private readonly translate = inject(TranslateService);
  private readonly formatFileSize = inject(FormatFileSizePipe);
  private readonly formatTime = inject(FormatTimePipe);
  private readonly localStorage = inject(LocalStorageService);
  private readonly dialog = inject(MatDialog);

  // Reactive i18n: force recomputation of translate.instant() calls on lang change.
  private readonly _lang = toSignal(this.translate.onLangChange, { initialValue: null });

  private readonly _selectedProfiles = linkedSignal<Record<string, string>>(() => {
    return this.localStorage.getScoped<Record<string, string>>(
      `remote.${this.selectedRemote().name}`,
      'selectedProfiles',
      {}
    );
  });

  readonly selectedProfile = computed(() => {
    const op = this.currentOpType();
    const profiles = this.profiles();
    const current = this._selectedProfiles()[op];

    if (current && profiles.some(p => p.name === current)) {
      return current;
    }

    return profiles[0]?.name ?? 'default';
  });

  protected readonly selectedRemote = computed(() => {
    const remote = this.remoteFacade.selectedRemote();
    if (!remote) throw new Error('[AppDetail] Selected remote is required');
    return remote;
  });

  readonly actionInProgress = computed(
    () => this.remoteFacade.actionInProgress()[this.selectedRemote().name] ?? []
  );

  // --- Derived: Operation Type ---
  readonly isOperationsType = computed(() => this.mainOperationType() === 'operations');

  readonly currentOpType = computed<PrimaryActionType>(() => {
    const op = this.isOperationsType()
      ? this.selectedSyncOperation()
      : (this.mainOperationType() as PrimaryActionType);
    return ALL_PRIMARY_ACTIONS.includes(op) ? op : 'mount';
  });

  readonly currentOpMetadata = computed(() => {
    const type = this.currentOpType();
    return (
      OPERATION_METADATA[type] ?? {
        label: 'dashboard.appDetail.syncSettings',
        icon: 'refresh',
        cssClass: 'primary',
        supportsVfs: false,
        supportsProfiles: false,
      }
    );
  });

  readonly operationActiveState = computed(() => this.isOperationActive(this.currentOpType()));

  readonly operationColor = computed<OperationColor>(
    () => (this.currentOpMetadata()?.cssClass as OperationColor) ?? 'primary'
  );

  readonly operationColorCssVar = computed(
    () => OPERATION_COLOR_VAR[this.operationColor()] ?? OPERATION_COLOR_VAR.warn
  );

  readonly iconAnimationClass = computed(() =>
    this.operationActiveState() ? (ACTION_ANIMATION_CLASS[this.currentOpType()] ?? '') : ''
  );

  // CSS class for the icon container — single operation state class or empty.
  protected readonly iconContainerClass = computed((): string => {
    const remote = this.selectedRemote();
    if (remote.status.mount.active) return 'mount';
    if (remote.status.serve.active) return 'serve';
    if (!this.isOperationsType() || !this.operationActiveState()) return '';
    const op = this.selectedSyncOperation();
    return op === 'check' || op === 'cryptcheck' ? 'check' : op;
  });

  // CSS class for operation-colored containers (profile selector, cron label).
  protected readonly operationColorClass = computed((): string => {
    const op = this.currentOpType();
    return `operation-${op === 'cryptcheck' ? 'check' : op}`;
  });

  // --- Derived: Sync Operations ---
  readonly primarySyncOps = computed<SyncOperationType[]>(() => {
    const remote = this.selectedRemote();
    const custom = (remote.syncActions ?? []).filter((a): a is SyncOperationType =>
      SYNC_TYPES.includes(a as any)
    );
    if (custom.length > 0) {
      return custom.slice(0, 3) as SyncOperationType[];
    }
    return MODE_DEFAULTS.operations as SyncOperationType[];
  });

  readonly moreSyncOps = computed<SyncOperationType[]>(() => {
    const primary = this.primarySyncOps();
    return SYNC_TYPES.filter(type => !primary.includes(type));
  });

  readonly syncOperations = computed<SyncOperationViewModel[]>(() =>
    SYNC_TYPES.map(type => ({
      type,
      ...OPERATION_METADATA[type],
      isActive: this.isOperationActive(type),
    }))
  );

  readonly isMoreSelected = computed(() =>
    this.moreSyncOps().includes(this.selectedSyncOperation())
  );

  readonly isAnyMoreRunning = computed(() =>
    this.moreSyncOps().some(type => this.isOperationActive(type))
  );

  readonly moreButtonLabel = computed(() => {
    const selected = this.selectedSyncOperation();
    if (this.isMoreSelected()) {
      const meta = OPERATION_METADATA[selected];
      const label = meta && meta.typeLabel ? this.translate.instant(meta.typeLabel) : '';
      return `${this.translate.instant('modals.actionSelection.moreButton')} (${label})`;
    }
    return this.translate.instant('modals.actionSelection.moreButton');
  });

  // --- Derived: Profiles ---
  readonly profiles = computed<{ name: string; label: string }[]>(() => {
    this._lang();
    const configKey = REMOTE_CONFIG_KEYS[this.currentOpType() as keyof typeof REMOTE_CONFIG_KEYS];
    if (!configKey) {
      return [{ name: 'default', label: this.translate.instant('dashboard.appDetail.default') }];
    }
    const profileMap = this.remoteSettings()[configKey as keyof RemoteSettings] as
      | Record<string, unknown>
      | undefined;
    const names = profileMap ? Object.keys(profileMap) : [];
    return names.length > 0
      ? names.map(name => ({ name, label: name }))
      : [{ name: 'default', label: this.translate.instant('dashboard.appDetail.default') }];
  });

  readonly enrichedProfiles = computed(() => {
    const configs = this.getProfileConfigMap(this.currentOpType()) as
      | Record<
          string,
          {
            app?: {
              cronEnabled?: boolean;
              cronExpression?: string | null;
              watchEnabled?: boolean;
              watchDelay?: number;
            };
          }
        >
      | undefined;

    return this.profiles().map(p => {
      const cfg = configs?.[p.name];
      const isActive = this.isOperationActive(this.currentOpType(), p.name);
      const hasSchedule = !!(cfg?.app?.cronEnabled && cfg?.app?.cronExpression);
      const hasWatcher = !!cfg?.app?.watchEnabled;
      const isMonitored = hasSchedule || hasWatcher;
      return {
        ...p,
        isActive,
        hasSchedule,
        hasWatcher,
        status: isActive ? 'running' : isMonitored ? 'scheduled' : 'idle',
      };
    });
  });

  readonly showProfileSelector = computed(() => this.profiles().length > 1);

  // --- Derived: Job / Serve State ---
  readonly filteredRunningServes = computed(
    () => (this.selectedRemote().status.serve?.serves ?? []) as ServeListItem[]
  );

  readonly jobId = computed(() => {
    if (!this.isOperationsType()) return undefined;
    const state = this.getOpState(this.selectedSyncOperation()) as RemoteOperationState;
    if (!state) return undefined;
    const profile = this.selectedProfile() ?? 'default';
    return state.activeProfiles?.[profile] ?? state.lastRunProfiles?.[profile];
  });

  readonly currentGroupName = computed(
    () =>
      `${this.currentOpType()}/${this.selectedRemote().name}/${this.selectedProfile() ?? 'default'}`
  );

  readonly activeGroupJob = computed<JobInfo | null>(() =>
    this.jobService.getLatestJobForRemote(
      this.selectedRemote().name,
      this.selectedProfile() ?? 'default',
      this.currentOpType()
    )
  );

  readonly isDryRun = computed(() => {
    const opType = this.currentOpType();
    if (opType === 'bisync') {
      const configKey = 'bisyncConfigs';
      const profiles = this.remoteSettings()[configKey] as Record<string, BisyncConfig> | undefined;
      const profile = this.selectedProfile();
      const cfg = profiles?.[profile];
      if (!cfg) return false;
      return !!cfg.rclone?.dryRun;
    } else if ((BACKEND_PROFILE_SUPPORTED_OPS as readonly string[]).includes(opType)) {
      const configKey = REMOTE_CONFIG_KEYS[
        opType as keyof typeof REMOTE_CONFIG_KEYS
      ] as keyof RemoteSettings;
      if (!configKey) return false;
      const profiles = this.remoteSettings()[configKey] as
        | Record<
            string,
            | SyncConfig
            | CopyConfig
            | MoveConfig
            | CheckConfig
            | DeleteConfig
            | CopyurlConfig
            | ArchivecreateConfig
          >
        | undefined;
      const profile = this.selectedProfile();
      const cfg = profiles?.[profile];
      const backendProfileName = cfg?.app?.backendProfile || 'default';

      const backendConfigs = this.remoteSettings()['backendConfigs'] as
        | Record<string, Record<string, any>>
        | undefined;
      const backendCfg = backendConfigs?.[backendProfileName];
      return !!backendCfg?.['DryRun'];
    }
    return false;
  });

  readonly isResync = computed(() => {
    const opType = this.currentOpType();
    if (opType === 'bisync') {
      const configKey = 'bisyncConfigs';
      const profiles = this.remoteSettings()[configKey] as Record<string, BisyncConfig> | undefined;
      const profile = this.selectedProfile();
      const cfg = profiles?.[profile];
      if (!cfg) return false;
      return !!cfg.rclone?.resync;
    }
    return false;
  });

  // --- Derived: Live Data (from service) ---
  readonly jobStats = computed<GlobalStats>(() => {
    return (this.activeGroupJob()?.stats as GlobalStats | undefined) ?? DEFAULT_JOB_STATS;
  });

  readonly activeTransfers = computed<TransferFile[]>(() => {
    const transferring =
      (this.activeGroupJob()?.stats as JobStatsWithCompleted | undefined)?.transferring ?? [];

    return (transferring as TransferFile[]).map(f => ({
      ...f,
      percentage: f.size > 0 ? Math.min(100, Math.round((f.bytes / f.size) * 100)) : 0,
      isError: false,
      isCompleted: false,
    }));
  });

  readonly completedTransfers = computed<CompletedTransfer[]>(() => {
    const activeJob = this.activeGroupJob();
    if (!activeJob) return [];

    if (this.currentOpType() === 'check' || this.currentOpType() === 'cryptcheck') {
      return mapCheckOutput(activeJob);
    }

    const completed = (activeJob.stats as JobStatsWithCompleted | undefined)?.completed;
    return Array.isArray(completed) ? completed.map(mapRawTransfer) : [];
  });

  // --- Derived: Timing ---
  readonly resolvedStartTime = computed<Date | undefined>(() => {
    const statsStart = parseDateValue(this.jobStats().startTime);
    const jobStart = parseDateValue(this.activeGroupJob()?.start_time);
    if (statsStart && jobStart) return statsStart >= jobStart ? statsStart : jobStart;
    return statsStart ?? jobStart;
  });

  readonly resolvedEndTime = computed<Date | undefined>(() =>
    parseDateValue(this.activeGroupJob()?.end_time)
  );

  readonly resolvedElapsedSeconds = computed<number>(() => {
    const elapsed = this.jobStats().elapsedTime;
    if (elapsed > 0) return elapsed;
    const startTime = this.resolvedStartTime();
    if (!startTime) return 0;
    const endTime = this.resolvedEndTime() ?? new Date();
    return Math.max(0, Math.floor((endTime.getTime() - startTime.getTime()) / 1000));
  });

  // --- Derived: Cron Schedules ---
  readonly cronSchedules = computed<
    { profileName: string; cronExpression: string; humanReadable: string }[]
  >(() => {
    this._lang();
    const configKey = REMOTE_CONFIG_KEYS[
      this.selectedSyncOperation() as keyof typeof REMOTE_CONFIG_KEYS
    ] as keyof RemoteSettings;
    const configs = this.remoteSettings()[configKey] as
      | Record<
          string,
          | SyncConfig
          | CopyConfig
          | MoveConfig
          | BisyncConfig
          | CheckConfig
          | DeleteConfig
          | CopyurlConfig
          | ArchivecreateConfig
        >
      | undefined;
    if (!configs) return [];

    return Object.entries(configs)
      .filter(([, cfg]) => cfg?.app?.cronEnabled && cfg?.app?.cronExpression)
      .map(([profileName, cfg]) => {
        let humanReadable = 'Invalid schedule';
        const cronExpression = cfg.app.cronExpression ?? '';
        try {
          humanReadable = cronstrue(cronExpression, {
            locale: getCronstrueLocale(this.translate.getCurrentLang()),
          });
        } catch {
          console.warn(`Invalid cron expression for profile ${profileName}: ${cronExpression}`);
        }
        return { profileName, cronExpression, humanReadable };
      });
  });

  readonly selectedCronSchedule = computed(() => {
    const schedules = this.cronSchedules();
    const selected = this.selectedProfile();
    return selected
      ? (schedules.find(s => s.profileName === selected) ?? null)
      : (schedules[0] ?? null);
  });

  readonly hasCronSchedule = computed(() => this.selectedCronSchedule() !== null);

  readonly selectedWatcher = computed(() => {
    const configKey = REMOTE_CONFIG_KEYS[
      this.selectedSyncOperation() as keyof typeof REMOTE_CONFIG_KEYS
    ] as keyof RemoteSettings;
    const configs = this.remoteSettings()[configKey] as
      | Record<
          string,
          | SyncConfig
          | CopyConfig
          | MoveConfig
          | BisyncConfig
          | CheckConfig
          | DeleteConfig
          | CopyurlConfig
          | ArchivecreateConfig
        >
      | undefined;
    if (!configs) return null;

    const profileName = this.selectedProfile() || 'default';
    const cfg = configs[profileName];
    if (cfg?.app?.watchEnabled) {
      return {
        profileName,
        watchDelay: cfg.app.watchDelay ?? 5,
      };
    }
    return null;
  });

  readonly hasWatcher = computed(() => this.selectedWatcher() !== null);

  // --- Derived: Settings Sections ---
  readonly operationSettingsSections = computed<RemoteSettingsSection[]>(() => {
    this._lang();
    const metadata = this.currentOpMetadata();
    if (!metadata) return [];
    return this.buildSettingsSections(
      this.currentOpType(),
      this.translate.instant(metadata.label),
      metadata.icon,
      'operation'
    );
  });

  readonly sharedSettingsSections = computed<RemoteSettingsSection[]>(() => {
    const sections: RemoteSettingsSection[] = [];
    const metadata = this.currentOpMetadata();

    if (metadata?.supportsVfs) {
      const m = OPERATION_METADATA['vfs'];
      sections.push(
        ...this.buildSettingsSections('vfs', this.translate.instant(m.label), m.icon, 'shared')
      );
    }

    const sharedTypes = ['filter', 'backend', 'runtimeRemote'] as const;
    for (const type of sharedTypes) {
      const m = OPERATION_METADATA[type];
      const icon =
        type === 'runtimeRemote'
          ? this.iconService.getIconName(this.selectedRemote().type)
          : m.icon;
      sections.push(
        ...this.buildSettingsSections(type, this.translate.instant(m.label), icon, 'shared')
      );
    }

    return sections;
  });

  readonly operationSettingsHeading = computed(() => {
    const metadata = this.currentOpMetadata();
    if (!metadata) return '';
    const opLabel = this.translate.instant('modals.remoteConfig.steps.' + this.currentOpType());
    if (this.operationSettingsSections().length > 1) {
      return this.translate.instant('dashboard.appDetail.profilesLabel', { op: opLabel });
    }
    return (
      opLabel + ' ' + this.translate.instant('dashboard.appDetail.settingsLabel', { op: '' }).trim()
    );
  });

  readonly operationSettingsDescription = computed(() => {
    const desc = this.currentOpMetadata()?.description;
    return desc ? this.translate.instant(desc) : '';
  });

  private readonly settingsPanelConfigMap = computed(() => {
    const settings = this.remoteSettings();
    const allSections = [...this.operationSettingsSections(), ...this.sharedSettingsSections()];
    return new Map(allSections.map(s => [s.key, this.buildPanelConfig(s, settings)]));
  });

  getSettingsPanelConfig(section: RemoteSettingsSection): SettingsPanelConfig {
    return this.settingsPanelConfigMap().get(section.key) ?? { section, settings: {} };
  }

  // --- Derived: Control Configs ---
  readonly controlConfigs = computed<OperationControlConfig[]>(() => {
    const type = this.currentOpType();
    const metadata = this.currentOpMetadata();
    const configKey = REMOTE_CONFIG_KEYS[type as keyof typeof REMOTE_CONFIG_KEYS];
    if (!configKey || !metadata) return [];

    const profiles = this.remoteSettings()[configKey as keyof RemoteSettings] as
      | Record<string, ProfileConfig>
      | undefined;
    const entries = profiles ? Object.entries(profiles) : [];

    const all =
      entries.length > 0
        ? entries.map(([name, cfg]) => this.buildControlConfig(type, cfg, name))
        : [this.buildControlConfig(type, {}, undefined)];

    const selected = this.selectedProfile();
    if (!this.showProfileSelector() || all.length <= 1) return all;
    return all.filter(c => c.profileName === selected);
  });

  // --- Derived: Stats & Transfer Panels ---
  readonly jobInfoConfig = computed<JobInfoConfig>(() => {
    const startTime = this.resolvedStartTime();
    const endTime = this.resolvedEndTime();
    const elapsedSeconds = this.resolvedElapsedSeconds();
    const duration = elapsedSeconds > 0 ? this.formatTime.transform(elapsedSeconds) : undefined;

    return {
      operationType: this.isOperationsType()
        ? this.selectedSyncOperation()
        : (this.mainOperationType() as unknown as PrimaryActionType),
      jobId: this.jobId() ? Number(this.jobId()) : undefined,
      status: this.activeGroupJob()?.status,
      startTime,
      endTime,
      duration,
      dryRun: this.activeGroupJob()?.dry_run,
    };
  });

  readonly statsConfig = computed<StatsPanelConfig>(() => {
    const s = this.jobStats();
    const meta = this.currentOpMetadata();
    const progress = s.totalBytes > 0 ? Math.min(100, (s.bytes / s.totalBytes) * 100) : 0;
    const etaProgress =
      s.elapsedTime && s.eta ? (s.elapsedTime / (s.elapsedTime + s.eta)) * 100 : 0;
    const t = (key: string, params?: object): string => this.translate.instant(key, params);

    return {
      title: t('dashboard.appDetail.transferStatistics', { op: meta ? t(meta.label) : 'Transfer' }),
      icon: meta?.icon ?? 'chart',
      operationColor: this.operationColor(),
      stats: [
        {
          value: this.formatProgress(),
          label: t('dashboard.appDetail.progress'),
          isPrimary: true,
          progress,
        },
        {
          value: `${this.formatFileSize.transform(s.speed || 0)}/s`,
          label: t('dashboard.appDetail.speed'),
        },
        {
          value: this.formatTime.transform(s.eta),
          label: t('dashboard.appDetail.eta'),
          isPrimary: true,
          progress: etaProgress,
        },
        {
          value: `${s.transfers || 0}/${s.totalTransfers || 0}`,
          label: t('dashboard.appDetail.files'),
        },
        {
          value: `${s.checks || 0}/${s.totalChecks || 0}`,
          label: t('dashboard.appDetail.checks'),
        },
        {
          value: s.errors || 0,
          label: t('dashboard.appDetail.errors'),
          hasError: (s.errors || 0) > 0,
          tooltip: s.lastError || undefined,
        },
      ],
    };
  });

  readonly transferActivityConfig = computed<TransferActivityPanelConfig>(() => ({
    activeTransfers: this.activeTransfers(),
    completedTransfers: this.completedTransfers(),
    operationColor: this.operationColor(),
    remoteName: this.selectedRemote().name,
    showHistory: this.completedTransfers().length > 0,
    jobType: this.currentOpType(),
  }));

  // --- Public Methods ---

  onProfileSelect(name: string): void {
    const op = this.currentOpType();
    const updatedMap = { ...this._selectedProfiles(), [op]: name };
    this._selectedProfiles.set(updatedMap);
    this.localStorage.setScoped(
      `remote.${this.selectedRemote().name}`,
      'selectedProfiles',
      updatedMap
    );
  }

  onSyncOpSelect(type: SyncOperationType): void {
    this.selectedSyncOperation.set(type);
    this.localStorage.setScoped(
      `remote.${this.selectedRemote().name}`,
      'selectedSyncOperation',
      type
    );
  }

  onAddProfile(): void {
    this.openRemoteConfigModal.emit({
      editTarget: this.currentOpType(),
      autoAddProfile: true,
      remoteType: this.selectedRemote().type,
    });
  }

  triggerOpenInFiles(path: string): void {
    this.openInFiles.emit({ remoteName: this.selectedRemote().name, path });
  }

  onEditSettings(event: { section: string; settings: RemoteSettings }): void {
    const [type, profileName] = event.section.split(':');
    this.openRemoteConfigModal.emit({
      editTarget: type,
      targetProfile: profileName,
      remoteType: this.selectedRemote().type,
    });
  }

  onConfigureActions(): void {
    const remote = this.selectedRemote();
    if (!remote) return;

    this.dialog
      .open(ActionSelectionModalComponent, {
        ...STANDARD_MODAL_SIZE,
        disableClose: true,
        data: {
          remoteName: remote.name,
          primaryActions: remote.syncActions ?? [],
          allowedKeys: SYNC_TYPES,
        },
      })
      .afterClosed()
      .subscribe(async (result: PrimaryActionType[] | undefined) => {
        if (result !== undefined) {
          try {
            await this.remoteFacade.updateRemoteSettings(remote.name, {
              syncActions: result,
            });
          } catch (error) {
            console.error('Failed to update sync actions:', error);
          }
        }
      });
  }

  async onResetStats(): Promise<void> {
    const groupName = this.currentGroupName();
    try {
      await this.jobService.resetGroupStats(groupName);
    } catch (error) {
      console.error('Failed to reset group stats:', error);
    }
  }

  async onDeleteJob(): Promise<void> {
    const job = this.activeGroupJob();
    if (!job) return;
    try {
      await this.jobService.deleteJob(job.jobid);
    } catch (error) {
      console.error('Failed to delete job:', error);
    }
  }

  async toggleDryRun(): Promise<void> {
    const opType = this.currentOpType();
    const profile = this.selectedProfile();
    const settings = this.remoteSettings();

    if (opType === 'bisync') {
      const configKey = 'bisyncConfigs';
      const profiles = (settings[configKey] as Record<string, BisyncConfig>) ?? {};
      const existing = profiles[profile];
      const newDryRun = !existing?.rclone?.dryRun;

      await this.remoteFacade.updateRemoteSettings(this.selectedRemote().name, {
        [configKey]: {
          ...profiles,
          [profile]: { ...existing, rclone: { ...existing?.rclone, dryRun: newDryRun } },
        },
      });
    } else if ((BACKEND_PROFILE_SUPPORTED_OPS as readonly string[]).includes(opType)) {
      const configKey = REMOTE_CONFIG_KEYS[
        opType as keyof typeof REMOTE_CONFIG_KEYS
      ] as keyof RemoteSettings;
      if (!configKey) return;

      const profiles =
        (settings[configKey] as Record<
          string,
          | SyncConfig
          | CopyConfig
          | MoveConfig
          | CheckConfig
          | DeleteConfig
          | CopyurlConfig
          | ArchivecreateConfig
        >) ?? {};
      const cfg = profiles[profile];
      const backendProfileName = cfg?.app?.backendProfile || 'default';
      const backendConfigs = (settings['backendConfigs'] as Record<string, any>) ?? {};
      const existingBackend = backendConfigs[backendProfileName] ?? {};

      await this.remoteFacade.updateRemoteSettings(this.selectedRemote().name, {
        backendConfigs: {
          ...backendConfigs,
          [backendProfileName]: { ...existingBackend, DryRun: !existingBackend['DryRun'] },
        },
      });
    }
  }

  async toggleResync(): Promise<void> {
    const opType = this.currentOpType();
    if (opType !== 'bisync') return;

    const profile = this.selectedProfile();
    const configKey = 'bisyncConfigs';
    const profiles = (this.remoteSettings()[configKey] as Record<string, BisyncConfig>) ?? {};
    const existing = profiles[profile];

    await this.remoteFacade.updateRemoteSettings(this.selectedRemote().name, {
      [configKey]: {
        ...profiles,
        [profile]: {
          ...existing,
          rclone: { ...existing?.rclone, resync: !existing?.rclone?.resync },
        },
      },
    });
  }

  // --- Private Helpers ---

  private getOpState(
    type: SyncOperationType | 'mount' | 'serve'
  ): RemoteOperationState | RemoteServeState | null {
    return (this.selectedRemote().status[type as keyof Omit<RemoteStatus, 'diskUsage'>] ?? null) as
      | RemoteOperationState
      | RemoteServeState
      | null;
  }

  private isOperationActive(type: string, profileName?: string): boolean {
    const state = this.getOpState(type as SyncOperationType | 'mount' | 'serve');
    if (!state) return false;
    if (type === 'serve') {
      const s = state as RemoteServeState;
      return profileName ? (s.serves?.some(sv => sv.profile === profileName) ?? false) : !!s.active;
    }
    const op = state as RemoteOperationState;
    return profileName ? !!op.activeProfiles?.[profileName] : !!op.active;
  }

  private getProfileConfigMap(type: string): Record<string, unknown> | undefined {
    const configKey = REMOTE_CONFIG_KEYS[type as keyof typeof REMOTE_CONFIG_KEYS];
    return configKey
      ? (this.remoteSettings()[configKey as keyof RemoteSettings] as
          | Record<string, unknown>
          | undefined)
      : undefined;
  }

  private buildSettingsSections(
    type: string,
    titlePrefix: string,
    icon: string,
    group: 'operation' | 'shared'
  ): RemoteSettingsSection[] {
    const profiles = this.getProfileConfigMap(type);
    const names = profiles ? Object.keys(profiles) : [];
    return names.length > 0
      ? names.map(name => ({
          key: `${type}:${name}`,
          title: `${titlePrefix} (${name})`,
          icon,
          group,
        }))
      : [{ key: type, title: titlePrefix, icon, group }];
  }

  private buildPanelConfig(
    section: RemoteSettingsSection,
    settings: RemoteSettings
  ): SettingsPanelConfig {
    const [key, profileName] = section.key.split(':');
    const configKey = REMOTE_CONFIG_KEYS[
      key as keyof typeof REMOTE_CONFIG_KEYS
    ] as keyof RemoteSettings;
    const profiles = settings[configKey] as Record<string, unknown> | undefined;

    let specificSettings: Record<string, unknown>;
    if (profileName) {
      specificSettings = (profiles?.[profileName] as Record<string, unknown>) ?? {};
    } else if (profiles && (SYNC_TYPES as string[]).includes(key)) {
      specificSettings =
        (profiles['default'] as Record<string, unknown>) ?? Object.values(profiles)[0] ?? {};
    } else {
      specificSettings = (profiles as Record<string, unknown>) ?? {};
    }

    return { section, settings: specificSettings };
  }

  private buildControlConfig(
    type: PrimaryActionType,
    config: ProfileConfig,
    profileName?: string
  ): OperationControlConfig {
    const metadata = OPERATION_METADATA[type];
    const isActive = this.isOperationActive(type, profileName);
    const actionMatch = this.actionInProgress()?.find(
      a =>
        (a.type === type ||
          (type === 'mount' && a.type === 'unmount') ||
          (a.type === 'stop' && a.operationType === type)) &&
        (a.profileName === profileName || (!a.profileName && !profileName))
    );
    const actionType = actionMatch?.type;
    const isLoading = !!actionType;
    const t = (key: string, params?: object): string => this.translate.instant(key, params);
    const opLabel = t(metadata.typeLabel || metadata.label);
    const isMount = type === 'mount';

    const rclone = config.rclone || {};
    const resolvedSource = rclone.srcFs ?? rclone.path1 ?? rclone.fs;
    const resolvedDest = rclone.dstFs ?? rclone.path2 ?? rclone.mountPoint;

    const pathConfig: PathDisplayConfig =
      type === 'serve'
        ? {
            source: resolvedSource ?? t('dashboard.appDetail.notConfigured'),
            destination: `${((rclone.type as string) ?? 'http').toUpperCase()} at ${rclone.addr ?? t('dashboard.appDetail.default')}`,
            sourceLabel: t('dashboard.appDetail.serving'),
            destinationLabel: t('dashboard.appDetail.accessibleVia'),
            showOpenButtons: true,
            hasSource: !!resolvedSource,
            hasDestination: false,
            isDestinationActive: isActive,
          }
        : {
            source: resolvedSource ?? t('dashboard.appDetail.notConfigured'),
            destination: this.normalizeSinglePath(
              resolvedDest ?? t('dashboard.appDetail.notConfigured')
            ),
            showOpenButtons: true,
            isDestinationActive: type === 'mount' ? isActive : true,
            actionInProgress: (actionType as RemoteAction) ?? undefined,
            hasSource: !!resolvedSource,
            hasDestination: !!resolvedDest,
            hideDestination: type === 'delete',
          };

    return {
      operationType: type,
      isActive,
      isLoading,
      cssClass: metadata.cssClass,
      pathConfig,
      primaryButtonLabel: isLoading
        ? t(isMount ? 'dashboard.appDetail.mount' : 'dashboard.appDetail.starting', { op: opLabel })
        : t(isMount ? 'dashboard.appDetail.mount' : 'dashboard.appDetail.start', { op: opLabel }),
      secondaryButtonLabel: isLoading
        ? t(isMount ? 'dashboard.appDetail.unmounting' : 'dashboard.appDetail.stopping', {
            op: opLabel,
          })
        : t(isMount ? 'dashboard.appDetail.unmount' : 'dashboard.appDetail.stop', { op: opLabel }),
      primaryIcon: metadata.icon,
      secondaryIcon: isMount ? 'eject' : 'stop',
      actionInProgress: (actionType as RemoteAction) ?? undefined,
      operationDescription: metadata.description ? t(metadata.description) : undefined,
      profileName,
    };
  }

  private formatProgress(): string {
    const { bytes, totalBytes } = this.jobStats();
    return totalBytes > 0
      ? `${this.formatFileSize.transform(bytes)} / ${this.formatFileSize.transform(totalBytes)}`
      : this.formatFileSize.transform(bytes);
  }

  private normalizeSinglePath(path: string | string[]): string {
    return Array.isArray(path) ? path[0] || '' : path;
  }
}

function parseDateValue(value?: string | null): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
