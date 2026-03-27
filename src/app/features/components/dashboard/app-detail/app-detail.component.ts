import { NgClass, TitleCasePipe } from '@angular/common';
import {
  Component,
  inject,
  signal,
  computed,
  effect,
  input,
  untracked,
  model,
  output,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslateService, TranslateModule } from '@ngx-translate/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDividerModule } from '@angular/material/divider';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatTabsModule } from '@angular/material/tabs';
import { FormatTimePipe } from 'src/app/shared/pipes/format-time.pipe';
import { FormatFileSizePipe } from 'src/app/shared/pipes/format-file-size.pipe';
import {
  ActionState,
  CompletedTransfer,
  GlobalStats,
  DEFAULT_JOB_STATS,
  JobInfoConfig,
  OperationControlConfig,
  PathDisplayConfig,
  PrimaryActionType,
  Remote,
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
} from '@app/types';
import {
  JobInfoPanelComponent,
  OperationControlComponent,
  SettingsPanelComponent,
  StatsPanelComponent,
  TransferActivityPanelComponent,
} from '../../../../shared/detail-shared';
import { ServeCardComponent } from '../../../../shared/components/serve-card/serve-card.component';
import { IconService, SystemInfoService, JobManagementService } from '@app/services';
import { toString as cronstrue } from 'cronstrue';
import { VfsControlPanelComponent } from '../../../../shared/detail-shared/vfs-control/vfs-control-panel.component';
import { getCronstrueLocale } from 'src/app/services/i18n/cron-locale.mapper';

interface ProfileConfig {
  source?: string;
  dest?: string;
  destination?: string;
  options?: { type?: string; addr?: string; [key: string]: unknown };
}

@Component({
  selector: 'app-app-detail',
  standalone: true,
  imports: [
    NgClass,
    TitleCasePipe,
    MatIconModule,
    MatTooltipModule,
    MatDividerModule,
    MatCardModule,
    MatButtonModule,
    MatTabsModule,
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
  mainOperationType = input<PrimaryActionType>('mount');
  selectedSyncOperation = model<SyncOperationType>('sync');
  selectedRemote = input.required<Remote>();
  remoteSettings = input<RemoteSettings>({});
  actionInProgress = input<ActionState[] | null | undefined>(null);

  // --- Outputs ---
  openRemoteConfigModal = output<{
    editTarget?: string;
    existingConfig?: RemoteSettings;
    initialSection?: string;
    targetProfile?: string;
    remoteType?: string;
  }>();
  openInFiles = output<{ remoteName: string; path: string }>();
  startJob = output<{
    type: PrimaryActionType;
    remoteName: string;
    profileName?: string;
  }>();
  stopJob = output<{
    type: PrimaryActionType;
    remoteName: string;
    profileName?: string;
    serveId?: string;
  }>();

  // --- Services ---
  private readonly jobService = inject(JobManagementService);
  readonly iconService = inject(IconService);
  private readonly translate = inject(TranslateService);
  private readonly formatFileSize = inject(FormatFileSizePipe);
  private readonly formatTime = inject(FormatTimePipe);
  private readonly systemInfoService = inject(SystemInfoService);

  private readonly langChange = toSignal(this.translate.onLangChange, { initialValue: null });

  // --- State ---
  private readonly groupStats = signal<GlobalStats | null>(null);
  readonly jobStats = computed(() => this.groupStats() ?? DEFAULT_JOB_STATS);

  readonly activeTransfers = signal<TransferFile[]>([]);
  readonly completedTransfers = signal<CompletedTransfer[]>([]);
  readonly selectedProfile = signal<string | null>(null);

  private lastTransferCount = 0;

  private static readonly POLL_INTERVAL_MS = 1000;

  private static readonly ANIMATION_CLASSES: Partial<
    Record<SyncOperationType | PrimaryActionType, string>
  > = {
    sync: 'animate-spin',
    copy: 'animate-breathing',
    move: 'animate-move',
    bisync: 'animate-breathing',
    serve: 'animate-breathing',
    mount: 'animate-breathing',
  };

  readonly syncOperations = computed<SyncOperationViewModel[]>(() =>
    (['sync', 'bisync', 'move', 'copy'] as const).map(type => ({
      type,
      ...OPERATION_METADATA[type],
      isActive: this.isOperationActive(type),
    }))
  );

  readonly selectedSyncOpIndex = computed(() =>
    this.syncOperations().findIndex(op => op.type === this.selectedSyncOperation())
  );
  readonly selectedSyncOpCol = computed(() => this.selectedSyncOpIndex() % 2);
  readonly selectedSyncOpRow = computed(() => Math.floor(this.selectedSyncOpIndex() / 2));

  constructor() {
    effect(onCleanup => {
      const groupName = this.currentGroupName();
      untracked(() => this.resetTransfers());
      if (this.isSyncType() && this.operationActiveState() && groupName) {
        const timer = setInterval(
          () => void this.fetchGroupData(groupName),
          AppDetailComponent.POLL_INTERVAL_MS
        );
        onCleanup(() => clearInterval(timer));
      }
    });

    // Auto-select first profile when list changes
    effect(() => {
      const profiles = this.profiles();
      const current = this.selectedProfile();
      untracked(() => {
        if (profiles.length > 0 && (!current || !profiles.some(p => p.name === current))) {
          this.selectedProfile.set(profiles[0].name);
        }
      });
    });
  }

  // --- Computed: Profiles ---

  readonly profiles = computed<{ name: string; label: string }[]>(() => {
    this.langChange();
    const settings = this.remoteSettings();
    const opType = this.currentOpType();
    const configKey = REMOTE_CONFIG_KEYS[opType as keyof typeof REMOTE_CONFIG_KEYS];

    if (!configKey) {
      return [{ name: 'default', label: this.translate.instant('dashboard.appDetail.default') }];
    }

    const configProfiles = settings[configKey as keyof RemoteSettings] as
      | Record<string, unknown>
      | undefined;
    const profileNames = configProfiles ? Object.keys(configProfiles) : [];

    return profileNames.length > 0
      ? profileNames.map(name => ({ name, label: name }))
      : [{ name: 'default', label: this.translate.instant('dashboard.appDetail.default') }];
  });

  readonly enrichedProfiles = computed(() => {
    const opType = this.currentOpType();
    const configs = this.getProfileConfigs(opType) as
      | Record<string, { cronEnabled?: boolean; cronExpression?: string | null }>
      | undefined;

    return this.profiles().map(p => {
      const config = configs?.[p.name];
      const isActive = this.isOperationActive(opType, p.name);
      const hasSchedule = !!(config?.cronEnabled && config?.cronExpression);
      return {
        ...p,
        isActive,
        hasSchedule,
        status: isActive ? 'running' : hasSchedule ? 'scheduled' : 'idle',
      };
    });
  });

  readonly showProfileSelector = computed(() => this.profiles().length > 1);

  // --- Computed: Operation State ---

  readonly filteredRunningServes = computed(
    () => (this.selectedRemote().status.serve?.serves || []) as ServeListItem[]
  );

  readonly isSyncType = computed(() => this.mainOperationType() === 'sync');
  readonly currentOpType = computed(() =>
    this.isSyncType() ? this.selectedSyncOperation() : this.mainOperationType()
  );
  readonly currentOpMetadata = computed(() => OPERATION_METADATA[this.currentOpType()]);
  readonly operationActiveState = computed(() => this.isOperationActive(this.currentOpType()));

  readonly jobId = computed(() => {
    if (!this.isSyncType()) return undefined;
    const state = this.getOperationState(this.selectedSyncOperation()) as RemoteOperationState;
    return state?.activeProfiles?.[this.selectedProfile() ?? 'default'];
  });

  readonly currentGroupName = computed(() => {
    const name = this.selectedRemote().name;
    const profile = this.selectedProfile();
    return profile
      ? `${this.currentOpType()}/${name}/${profile}`
      : `${this.currentOpType()}/${name}`;
  });

  readonly operationClass = computed(() => {
    const type = this.currentOpType();
    return this.isSyncType() ? `sync-${type}-operation` : `${type}-operation`;
  });

  readonly operationColor = computed(
    () =>
      (this.currentOpMetadata()?.cssClass as
        | 'primary'
        | 'accent'
        | 'yellow'
        | 'orange'
        | 'purple') ?? 'primary'
  );

  readonly iconAnimationClass = computed(() =>
    this.operationActiveState()
      ? (AppDetailComponent.ANIMATION_CLASSES[this.currentOpType()] ?? '')
      : ''
  );

  // --- Computed: Settings Sections ---

  readonly operationSettingsSections = computed<RemoteSettingsSection[]>(() => {
    this.langChange();
    const sections: RemoteSettingsSection[] = [];
    const metadata = this.currentOpMetadata();
    const type = this.currentOpType();

    if (metadata) {
      this.addSettingsSections(
        sections,
        this.remoteSettings(),
        type,
        this.translate.instant(metadata.label),
        metadata.icon,
        'operation'
      );
    }
    return sections;
  });

  readonly sharedSettingsSections = computed<RemoteSettingsSection[]>(() => {
    const sections: RemoteSettingsSection[] = [];
    const settings = this.remoteSettings();
    const metadata = this.currentOpMetadata();

    if (metadata?.supportsVfs) {
      const vfsMeta = OPERATION_METADATA['vfs'];
      this.addSettingsSections(
        sections,
        settings,
        'vfs',
        this.translate.instant(vfsMeta.label),
        vfsMeta.icon,
        'shared'
      );
    }

    const filterMeta = OPERATION_METADATA['filter'];
    this.addSettingsSections(
      sections,
      settings,
      'filter',
      this.translate.instant(filterMeta.label),
      filterMeta.icon,
      'shared'
    );

    const backendMeta = OPERATION_METADATA['backend'];
    this.addSettingsSections(
      sections,
      settings,
      'backend',
      this.translate.instant(backendMeta.label),
      backendMeta.icon,
      'shared'
    );

    const runtimeMeta = OPERATION_METADATA['runtimeRemote'];
    this.addSettingsSections(
      sections,
      settings,
      'runtimeRemote',
      this.translate.instant(runtimeMeta.label),
      this.iconService.getIconName(this.selectedRemote().type),
      'shared'
    );

    return sections;
  });

  readonly operationSettingsHeading = computed(() => {
    const metadata = this.currentOpMetadata();
    if (!metadata) return '';
    const opLabel = this.translate.instant(metadata.label);
    return this.operationSettingsSections().length > 1
      ? this.translate.instant('dashboard.appDetail.profilesLabel', { op: opLabel })
      : opLabel;
  });

  readonly operationSettingsDescription = computed(() => {
    const metadata = this.currentOpMetadata();
    return metadata?.description ? this.translate.instant(metadata.description) : '';
  });

  // Pre-compute all settings panel configs into a Map so getSettingsPanelConfig()
  // is a cheap lookup instead of rebuilding on every CD cycle. This prevents child
  // expansion panels from resetting their open/closed state on each change detection run.
  private readonly settingsPanelConfigMap = computed(() => {
    const settings = this.remoteSettings();
    const allSections = [...this.operationSettingsSections(), ...this.sharedSettingsSections()];
    return new Map(
      allSections.map(section => [section.key, this.buildSettingsPanelConfig(section, settings)])
    );
  });

  getSettingsPanelConfig(section: RemoteSettingsSection): SettingsPanelConfig {
    return this.settingsPanelConfigMap().get(section.key)!;
  }

  // --- Computed: Control Configs ---

  readonly unifiedControlConfigs = computed<OperationControlConfig[]>(() => {
    const type = this.currentOpType() as PrimaryActionType;
    const metadata = this.currentOpMetadata();
    const settings = this.remoteSettings();
    const configKey = REMOTE_CONFIG_KEYS[type as keyof typeof REMOTE_CONFIG_KEYS];

    if (!configKey || !metadata) return [];

    const profiles = settings[configKey as keyof RemoteSettings] as
      | Record<string, ProfileConfig>
      | undefined;
    const profileEntries = profiles ? Object.entries(profiles) : [];

    return profileEntries.length > 0
      ? profileEntries.map(([profileName, profile]) =>
          this.createUnifiedControlConfig(type, profile, profileName)
        )
      : [this.createUnifiedControlConfig(type, {}, undefined)];
  });

  readonly filteredControlConfigs = computed(() => {
    const configs = this.unifiedControlConfigs();
    const selected = this.selectedProfile();

    if (!this.showProfileSelector() || configs.length <= 1) return configs;
    return configs.filter(c => c.profileName === selected);
  });

  // --- Computed: Job Info / Stats / Transfers ---

  readonly jobInfoConfig = computed<JobInfoConfig>(() => {
    const profiles = this.profiles();
    return {
      operationType: this.isSyncType()
        ? this.selectedSyncOperation()
        : (this.mainOperationType() ?? 'mount'),
      jobId: this.jobId() ? Number(this.jobId()) : undefined,
      startTime: this.jobStats().startTime
        ? new Date(this.jobStats().startTime as string)
        : undefined,
      profiles,
      selectedProfile: this.selectedProfile() ?? undefined,
      showProfileSelector: this.showProfileSelector(),
    };
  });

  readonly statsConfig = computed<StatsPanelConfig>(() => {
    const statsData = this.jobStats();
    const progress = this.calculateProgress();
    const meta = this.currentOpMetadata();
    const etaProgress =
      statsData.elapsedTime && statsData.eta
        ? (statsData.elapsedTime / (statsData.elapsedTime + statsData.eta)) * 100
        : 0;

    return {
      title: this.translate.instant('dashboard.appDetail.transferStatistics', {
        op: meta ? this.translate.instant(meta.label) : 'Transfer',
      }),
      icon: meta?.icon ?? 'bar_chart',
      stats: [
        {
          value: this.formatProgress(),
          label: this.translate.instant('dashboard.appDetail.progress'),
          isPrimary: true,
          progress,
        },
        {
          value: this.formatSpeed(statsData.speed || 0),
          label: this.translate.instant('dashboard.appDetail.speed'),
        },
        {
          value: this.formatTime.transform(statsData.eta),
          label: this.translate.instant('dashboard.appDetail.eta'),
          isPrimary: true,
          progress: etaProgress,
        },
        {
          value: `${statsData.transfers || 0}/${statsData.totalTransfers || 0}`,
          label: this.translate.instant('dashboard.appDetail.files'),
        },
        {
          value: statsData.errors || 0,
          label: this.translate.instant('dashboard.appDetail.errors'),
          hasError: (statsData.errors || 0) > 0,
          tooltip: statsData.lastError,
        },
        {
          value: this.formatTime.transform(statsData.elapsedTime),
          label: this.translate.instant('dashboard.appDetail.duration'),
        },
      ],
      operationClass: this.operationClass(),
      operationColor: this.operationColor(),
    };
  });

  readonly transferActivityConfig = computed<TransferActivityPanelConfig>(() => {
    const completedTransfers = this.completedTransfers();
    return {
      activeTransfers: this.activeTransfers(),
      completedTransfers,
      operationClass: this.operationClass(),
      operationColor: this.operationColor(),
      remoteName: this.selectedRemote().name,
      showHistory: completedTransfers.length > 0,
    };
  });

  // --- Cron Schedules ---

  readonly cronSchedules = computed<
    { profileName: string; cronExpression: string; humanReadable: string }[]
  >(() => {
    const settings = this.remoteSettings();
    const opType = this.selectedSyncOperation();
    const configKey = REMOTE_CONFIG_KEYS[
      opType as keyof typeof REMOTE_CONFIG_KEYS
    ] as keyof RemoteSettings;
    const configs = settings[configKey] as
      | Record<string, { cronEnabled?: boolean; cronExpression?: string | null }>
      | undefined;

    if (!configs) return [];

    const schedules: { profileName: string; cronExpression: string; humanReadable: string }[] = [];

    for (const [profileName, config] of Object.entries(configs)) {
      if (config?.cronEnabled && config?.cronExpression) {
        let humanReadable = 'Invalid schedule';
        try {
          const locale = getCronstrueLocale(this.translate.getCurrentLang());
          humanReadable = cronstrue(config.cronExpression, { locale });
        } catch {
          // keep default
        }
        schedules.push({ profileName, cronExpression: config.cronExpression, humanReadable });
      }
    }
    return schedules;
  });

  readonly selectedCronSchedule = computed(() => {
    const schedules = this.cronSchedules();
    const selected = this.selectedProfile();
    if (!selected) return schedules[0] ?? null;
    return schedules.find(s => s.profileName === selected) ?? null;
  });

  readonly hasCronSchedule = computed(() => this.selectedCronSchedule() !== null);

  // --- Public Methods ---

  onSyncOperationChange(operation: SyncOperationType): void {
    this.selectedSyncOperation.set(operation);
  }

  triggerOpenInFiles(path: string): void {
    this.openInFiles.emit({ remoteName: this.selectedRemote().name, path });
  }

  onEditSettings(event: { section: string; settings: RemoteSettings }): void {
    const [type, profileName] = event.section.split(':');
    this.openRemoteConfigModal.emit({
      editTarget: type,
      existingConfig: this.remoteSettings(),
      targetProfile: profileName,
      remoteType: type === 'runtimeRemote' ? this.selectedRemote().type : undefined,
    });
  }

  async onResetStats(): Promise<void> {
    const groupName = this.currentGroupName();
    if (groupName) {
      try {
        await this.jobService.resetGroupStats(groupName);
        this.resetTransfers();
        void this.fetchGroupData(groupName);
      } catch (error) {
        console.error('Failed to reset group stats:', error);
      }
    }
  }

  // --- Private Helpers ---

  private getOperationState(
    type: SyncOperationType | 'mount' | 'serve'
  ): RemoteOperationState | RemoteServeState | null {
    const remote = this.selectedRemote();
    return remote.status[type as keyof Omit<RemoteStatus, 'diskUsage'>] as
      | RemoteOperationState
      | RemoteServeState
      | null;
  }

  private isOperationActive(type: string, profileName?: string): boolean {
    const state = this.getOperationState(type as SyncOperationType | 'mount' | 'serve');
    if (!state) return false;

    if (type === 'serve') {
      const serveState = state as RemoteStatus['serve'];
      const serves = serveState?.serves ?? [];
      return profileName ? serves.some(s => s.profile === profileName) : !!serveState?.active;
    }
    if (type === 'mount') {
      const mountState = state as RemoteStatus['mount'];
      return profileName ? !!mountState?.activeProfiles?.[profileName] : !!mountState?.active;
    }
    if (['sync', 'copy', 'move', 'bisync'].includes(type)) {
      const opState = state as RemoteStatus['sync' | 'copy' | 'move' | 'bisync'];
      return profileName ? !!opState?.activeProfiles?.[profileName] : !!opState?.active;
    }
    return false;
  }

  private getProfileConfigs(type: string): Record<string, unknown> | undefined {
    const settings = this.remoteSettings();
    const configKey = REMOTE_CONFIG_KEYS[type as keyof typeof REMOTE_CONFIG_KEYS];
    return settings[configKey as keyof RemoteSettings] as Record<string, unknown> | undefined;
  }

  private addSettingsSections(
    sections: RemoteSettingsSection[],
    settings: RemoteSettings,
    type: string,
    titlePrefix: string,
    icon: string,
    group: 'operation' | 'shared'
  ): void {
    const profiles = settings[
      REMOTE_CONFIG_KEYS[type as keyof typeof REMOTE_CONFIG_KEYS] as keyof RemoteSettings
    ] as Record<string, unknown> | undefined;
    const profileNames = profiles ? Object.keys(profiles) : [];

    if (profileNames.length > 0) {
      profileNames.forEach(profileName => {
        sections.push({
          key: `${type}:${profileName}`,
          title: `${titlePrefix} (${profileName})`,
          icon,
          group,
        });
      });
    } else {
      sections.push({ key: type, title: titlePrefix, icon, group });
    }
  }

  private buildSettingsPanelConfig(
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
    } else if (profiles && (['sync', 'bisync', 'move', 'copy'] as string[]).includes(key)) {
      specificSettings =
        (profiles['default'] as Record<string, unknown>) || Object.values(profiles)[0] || {};
    } else {
      specificSettings = profiles ?? {};
    }

    return {
      section,
      settings: specificSettings,
      buttonColor: this.operationColor(),
    };
  }

  private createUnifiedControlConfig(
    type: PrimaryActionType,
    config: ProfileConfig,
    profileName?: string
  ): OperationControlConfig {
    const metadata = OPERATION_METADATA[type];
    const isActive = this.isOperationActive(type, profileName);
    const actionMatch = this.actionInProgress()?.find(
      a =>
        (a.type === type || (type === 'mount' && a.type === 'unmount')) &&
        (a.profileName === profileName || (!a.profileName && !profileName))
    );
    const actionType = actionMatch?.type;
    const isLoading = !!actionType;

    let pathConfig: PathDisplayConfig;
    if (type === 'serve') {
      const serveType = (config?.options?.type as string) ?? 'http';
      const serveAddr =
        (config?.options?.addr as string) ?? this.translate.instant('dashboard.appDetail.default');
      pathConfig = {
        source: config.source ?? `${this.selectedRemote().name}:`,
        destination: `${serveType.toUpperCase()} at ${serveAddr}`,
        sourceLabel: this.translate.instant('dashboard.appDetail.serving'),
        destinationLabel: this.translate.instant('dashboard.appDetail.accessibleVia'),
        showOpenButtons: false,
        operationColor: metadata.cssClass as any,
        isDestinationActive: isActive,
      };
    } else {
      pathConfig = {
        source: config.source ?? this.translate.instant('dashboard.appDetail.notConfigured'),
        destination:
          config.dest ??
          config.destination ??
          this.translate.instant('dashboard.appDetail.notConfigured'),
        showOpenButtons: true,
        operationColor: metadata.cssClass as any,
        isDestinationActive: type === 'mount' ? isActive : true,
        actionInProgress: (actionType as RemoteAction) ?? undefined,
      };
    }

    const t = (key: string, params?: object): string => this.translate.instant(key, params);
    const opLabel = t(metadata.typeLabel || metadata.label);
    const isMount = type === 'mount';

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

  // --- Data Fetching ---

  private async fetchGroupData(groupName: string): Promise<void> {
    try {
      const [groupStats, completedTransfers] = await Promise.all([
        this.systemInfoService.getStats(groupName) as Promise<GlobalStats | null>,
        this.loadCompletedTransfers(groupName),
      ]);

      if (groupStats) this.updateStatsSignals(groupStats);
      if (completedTransfers) this.completedTransfers.set(completedTransfers);
    } catch (error) {
      console.error('Error fetching group stats:', error);
    }
  }

  private async loadCompletedTransfers(group: string): Promise<CompletedTransfer[] | null> {
    try {
      const response: any = await this.jobService.getCompletedTransfers(group);
      const transfers = response?.transferred ?? response;
      if (!Array.isArray(transfers)) return null;
      return transfers.map((t: any) => this.mapTransfer(t));
    } catch {
      return null;
    }
  }

  private updateStatsSignals(stats: GlobalStats): void {
    this.trackCompletedFiles(stats);
    const transferring = this.processTransfers(stats.transferring);
    this.activeTransfers.set(transferring);
    this.groupStats.set({ ...stats, transferring });
  }

  private processTransfers(files: TransferFile[] = []): TransferFile[] {
    return files.map(f => ({
      ...f,
      percentage: f.size > 0 ? Math.min(100, Math.round((f.bytes / f.size) * 100)) : 0,
      isError: f.bytes < f.size && f.percentage === 100,
      isCompleted: false,
    }));
  }

  private trackCompletedFiles(stats: GlobalStats): void {
    const currentCount = stats.transfers ?? 0;
    if (currentCount <= this.lastTransferCount) return;

    const activeNames = new Set(stats.transferring?.map((f: TransferFile) => f.name) ?? []);
    const newCompletions: CompletedTransfer[] = this.activeTransfers()
      .filter(f => !activeNames.has(f.name) && f.percentage > 0 && f.percentage < 100)
      .map(file => ({
        ...file,
        checked: false,
        error: '',
        jobid: Number(this.jobId() ?? 0),
        status: 'completed' as const,
        startedAt: undefined,
        completedAt: new Date().toISOString(),
        srcFs: undefined,
        dstFs: undefined,
        group: undefined,
      }));

    if (newCompletions.length > 0) {
      this.completedTransfers.update(prev => {
        const uniqueNew = newCompletions.filter(nc => !prev.some(p => p.name === nc.name));
        return [...uniqueNew, ...prev].slice(0, 50);
      });
    }

    this.lastTransferCount = currentCount;
  }

  private mapTransfer(transfer: any): CompletedTransfer {
    let status: 'completed' | 'checked' | 'failed' | 'partial' = 'completed';
    if (transfer.error) status = 'failed';
    else if (transfer.checked) status = 'checked';
    else if (transfer.bytes > 0 && transfer.bytes < transfer.size) status = 'partial';

    return {
      name: transfer.name ?? '',
      size: transfer.size ?? 0,
      bytes: transfer.bytes ?? 0,
      checked: transfer.checked ?? false,
      error: transfer.error ?? '',
      jobid: transfer.group ? parseInt(transfer.group.replace('job/', '')) : 0,
      startedAt: transfer.started_at,
      completedAt: transfer.completed_at,
      srcFs: transfer.srcFs,
      dstFs: transfer.dstFs,
      group: transfer.group,
      status,
    };
  }

  private resetTransfers(): void {
    this.activeTransfers.set([]);
    this.completedTransfers.set([]);
    this.lastTransferCount = 0;
    this.groupStats.set(null);
  }

  // --- Stats Formatting ---

  private formatProgress(): string {
    const { bytes, totalBytes } = this.jobStats();
    return totalBytes > 0
      ? `${this.formatFileSize.transform(bytes)} / ${this.formatFileSize.transform(totalBytes)}`
      : this.formatFileSize.transform(bytes);
  }

  private formatSpeed(speed: number): string {
    return `${this.formatFileSize.transform(speed)}/s`;
  }

  private calculateProgress(): number {
    const { bytes, totalBytes } = this.jobStats();
    return totalBytes > 0 ? Math.min(100, (bytes / totalBytes) * 100) : 0;
  }
}
