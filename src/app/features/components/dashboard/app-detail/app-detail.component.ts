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
  JobInfo,
  JobInfoConfig,
  OperationColor,
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

const POLL_INTERVAL_MS = 1000;

const ANIMATION_CLASS: Partial<Record<PrimaryActionType, string>> = {
  sync: 'animate-spin',
  copy: 'animate-breathing',
  move: 'animate-move',
  bisync: 'animate-breathing',
  serve: 'animate-breathing',
  mount: 'animate-breathing',
};

const OPERATION_COLOR_VAR: Record<OperationColor, string> = {
  primary: 'var(--primary-color)',
  accent: 'var(--accent-color)',
  yellow: 'var(--yellow)',
  orange: 'var(--orange)',
  purple: 'var(--purple)',
  warn: 'var(--warn-color)',
};

interface JobStatsWithCompleted extends GlobalStats {
  completed?: RawTransfer[];
}

interface RawTransfer {
  name?: string;
  size?: number;
  bytes?: number;
  checked?: boolean;
  error?: string;
  group?: string;
  started_at?: string;
  completed_at?: string;
  srcFs?: string;
  dstFs?: string;
}

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
  readonly mainOperationType = input<PrimaryActionType>('mount');
  readonly selectedSyncOperation = model<SyncOperationType>('sync');
  readonly selectedRemote = input.required<Remote>();
  readonly remoteSettings = input<RemoteSettings>({});
  readonly actionInProgress = input<ActionState[] | null | undefined>(null);

  // --- Outputs ---
  readonly openRemoteConfigModal = output<{
    editTarget?: string;
    existingConfig?: RemoteSettings;
    initialSection?: string;
    targetProfile?: string;
    remoteType?: string;
    autoAddProfile?: boolean;
  }>();
  readonly openInFiles = output<{ remoteName: string; path: string }>();
  readonly startJob = output<{
    type: PrimaryActionType;
    remoteName: string;
    profileName?: string;
  }>();
  readonly stopJob = output<{
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

  // Reactive i18n: force recomputation of translate.instant() calls on lang change.
  private readonly _lang = toSignal(this.translate.onLangChange, { initialValue: null });

  // --- Internal State ---
  private readonly liveGroupStats = signal<GlobalStats | null>(null);
  private readonly liveActiveTransfers = signal<TransferFile[]>([]);
  private readonly liveCompletedTransfers = signal<CompletedTransfer[]>([]);
  private readonly errorHistory = signal<string[]>([]);
  private lastTransferCount = 0;

  readonly selectedProfile = signal<string | null>(null);

  // --- Derived: Operation Type ---
  readonly isSyncType = computed(() => this.mainOperationType() === 'sync');

  readonly currentOpType = computed<PrimaryActionType>(() =>
    this.isSyncType() ? this.selectedSyncOperation() : this.mainOperationType()
  );

  readonly currentOpMetadata = computed(() => OPERATION_METADATA[this.currentOpType()]);

  readonly operationActiveState = computed(() => this.isOperationActive(this.currentOpType()));

  readonly operationColor = computed<OperationColor>(
    () => (this.currentOpMetadata()?.cssClass as OperationColor) ?? 'primary'
  );

  readonly operationColorCssVar = computed(
    () => OPERATION_COLOR_VAR[this.operationColor()] ?? OPERATION_COLOR_VAR.warn
  );

  readonly iconAnimationClass = computed(() =>
    this.operationActiveState() ? (ANIMATION_CLASS[this.currentOpType()] ?? '') : ''
  );

  // --- Derived: Sync Operations ---
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

  // --- Derived: Profiles ---
  readonly profiles = computed<{ name: string; label: string }[]>(() => {
    this._lang(); // reactive i18n dependency
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
      | Record<string, { cronEnabled?: boolean; cronExpression?: string | null }>
      | undefined;

    return this.profiles().map(p => {
      const cfg = configs?.[p.name];
      const isActive = this.isOperationActive(this.currentOpType(), p.name);
      const hasSchedule = !!(cfg?.cronEnabled && cfg?.cronExpression);
      return {
        ...p,
        isActive,
        hasSchedule,
        status: isActive ? 'running' : hasSchedule ? 'scheduled' : 'idle',
      };
    });
  });

  readonly showProfileSelector = computed(() => this.profiles().length > 1);

  // --- Derived: Job / Serve State ---
  readonly filteredRunningServes = computed(
    () => (this.selectedRemote().status.serve?.serves ?? []) as ServeListItem[]
  );

  readonly jobId = computed(() => {
    if (!this.isSyncType()) return undefined;
    const state = this.getOpState(this.selectedSyncOperation()) as RemoteOperationState;
    if (!state) return undefined;
    const profile = this.selectedProfile() ?? 'default';
    return state.activeProfiles?.[profile] ?? state.lastRunProfiles?.[profile];
  });

  readonly currentGroupName = computed(() => {
    const profile = this.selectedProfile() ?? 'default';
    return `${this.currentOpType()}/${this.selectedRemote().name}/${profile}`;
  });

  readonly activeGroupJob = computed<JobInfo | null>(() =>
    this.jobService.getLatestJobForRemote(
      this.selectedRemote().name,
      this.selectedProfile() ?? 'default',
      this.currentOpType()
    )
  );

  readonly shouldPoll = computed(() => {
    const groupName = this.currentGroupName();
    const activeJob = this.activeGroupJob();
    return (
      this.isSyncType() &&
      this.operationActiveState() &&
      !!groupName &&
      activeJob?.status === 'Running'
    );
  });

  readonly jobStats = computed<GlobalStats>(() => {
    if (this.shouldPoll() && this.liveGroupStats()) return this.liveGroupStats()!;
    const stats = this.activeGroupJob()?.stats as GlobalStats | undefined;
    return stats ?? DEFAULT_JOB_STATS;
  });

  readonly activeTransfers = computed<TransferFile[]>(() => {
    if (this.shouldPoll()) return this.liveActiveTransfers();
    return (this.activeGroupJob()?.stats as JobStatsWithCompleted | undefined)?.transferring ?? [];
  });

  readonly completedTransfers = computed<CompletedTransfer[]>(() => {
    if (this.shouldPoll()) return this.liveCompletedTransfers();
    const completed = (this.activeGroupJob()?.stats as JobStatsWithCompleted | undefined)
      ?.completed;
    return Array.isArray(completed) ? completed.map(t => this.mapTransfer(t)) : [];
  });

  // --- Derived: Timing ---
  readonly resolvedStartTime = computed<Date | undefined>(() => {
    const statsStart = parseDateValue(this.jobStats().startTime);
    const jobStart = parseDateValue(this.activeGroupJob()?.start_time);
    if (statsStart && jobStart) {
      return statsStart >= jobStart ? statsStart : jobStart;
    }
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
    const configKey = REMOTE_CONFIG_KEYS[
      this.selectedSyncOperation() as keyof typeof REMOTE_CONFIG_KEYS
    ] as keyof RemoteSettings;
    const configs = this.remoteSettings()[configKey] as
      | Record<string, { cronEnabled?: boolean; cronExpression?: string | null }>
      | undefined;
    if (!configs) return [];

    return Object.entries(configs)
      .filter(([, cfg]) => cfg?.cronEnabled && cfg?.cronExpression)
      .map(([profileName, cfg]) => {
        let humanReadable = 'Invalid schedule';
        try {
          humanReadable = cronstrue(cfg.cronExpression!, {
            locale: getCronstrueLocale(this.translate.getCurrentLang()),
          });
        } catch {
          console.warn(`Invalid cron expression for profile ${profileName}: ${cfg.cronExpression}`);
        }
        return { profileName, cronExpression: cfg.cronExpression!, humanReadable };
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
    return this.settingsPanelConfigMap().get(section.key)!;
  }

  // --- Derived: Control Configs (unified + filtered in one computed) ---
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
    let duration: string | undefined;
    if (startTime && endTime) {
      const diffMs = endTime.getTime() - startTime.getTime();
      duration = this.formatTime.transform(Math.max(0, Math.floor(diffMs / 1000)));
    }
    return {
      operationType: this.isSyncType() ? this.selectedSyncOperation() : this.mainOperationType(),
      jobId: this.jobId() ? Number(this.jobId()) : undefined,
      status: this.activeGroupJob()?.status,
      startTime,
      endTime,
      duration,
    };
  });

  readonly statsConfig = computed<StatsPanelConfig>(() => {
    const s = this.jobStats();
    const meta = this.currentOpMetadata();
    const progress = s.totalBytes > 0 ? Math.min(100, (s.bytes / s.totalBytes) * 100) : 0;
    const etaProgress =
      s.elapsedTime && s.eta ? (s.elapsedTime / (s.elapsedTime + s.eta)) * 100 : 0;
    const t = (key: string, params?: object) => this.translate.instant(key, params);

    return {
      title: t('dashboard.appDetail.transferStatistics', { op: meta ? t(meta.label) : 'Transfer' }),
      icon: meta?.icon ?? 'bar_chart',
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
          value: s.errors || 0,
          label: t('dashboard.appDetail.errors'),
          hasError: (s.errors || 0) > 0,
          tooltip: this.errorHistory().length > 0 ? this.errorHistory().join('\n') : s.lastError,
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
  }));

  constructor() {
    // Reset live state when the group context changes (operation type, profile, or remote).
    effect(() => {
      this.currentGroupName();
      untracked(() => this.resetTransfers());
    });

    // Auto-select first valid profile when the list changes.
    effect(() => {
      const profiles = this.profiles();
      const current = this.selectedProfile();
      untracked(() => {
        if (profiles.length > 0 && (!current || !profiles.some(p => p.name === current))) {
          this.selectedProfile.set(profiles[0].name);
        }
      });
    });

    // Polling effect: runs while the current job is active.
    effect(onCleanup => {
      if (!this.shouldPoll()) return;
      const groupName = this.currentGroupName();

      untracked(() => void this.fetchGroupData(groupName));
      const timer = setInterval(() => void this.fetchGroupData(groupName), POLL_INTERVAL_MS);
      onCleanup(() => clearInterval(timer));
    });
  }

  // --- Public Methods ---

  onAddProfile(): void {
    this.openRemoteConfigModal.emit({
      editTarget: this.currentOpType(),
      existingConfig: this.remoteSettings(),
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
      existingConfig: this.remoteSettings(),
      targetProfile: profileName,
      remoteType: this.selectedRemote().type,
    });
  }

  async onResetStats(): Promise<void> {
    const groupName = this.currentGroupName();
    if (!groupName) return;
    try {
      await this.jobService.resetGroupStats(groupName);
      this.resetTransfers();
      void this.fetchGroupData(groupName);
    } catch (error) {
      console.error('Failed to reset group stats:', error);
    }
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
    } else if (profiles && (['sync', 'bisync', 'move', 'copy'] as string[]).includes(key)) {
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
    const t = (key: string, params?: object) => this.translate.instant(key, params);
    const opLabel = t(metadata.typeLabel || metadata.label);
    const isMount = type === 'mount';

    const pathConfig: PathDisplayConfig =
      type === 'serve'
        ? {
            source: config.source ?? t('dashboard.appDetail.notConfigured'),
            destination: `${((config.options?.type as string) ?? 'http').toUpperCase()} at ${config.options?.addr ?? t('dashboard.appDetail.default')}`,
            sourceLabel: t('dashboard.appDetail.serving'),
            destinationLabel: t('dashboard.appDetail.accessibleVia'),
            showOpenButtons: true,
            hasSource: !!config.source,
            hasDestination: false,
            isDestinationActive: isActive,
          }
        : {
            source: config.source ?? t('dashboard.appDetail.notConfigured'),
            destination:
              config.dest ?? config.destination ?? t('dashboard.appDetail.notConfigured'),
            showOpenButtons: true,
            isDestinationActive: type === 'mount' ? isActive : true,
            actionInProgress: (actionType as RemoteAction) ?? undefined,
            hasSource: !!config.source,
            hasDestination: !!(config.dest ?? config.destination),
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

  // --- Data Fetching ---

  private async fetchGroupData(groupName: string): Promise<void> {
    try {
      const groupStats = (await this.systemInfoService.getStats(groupName)) as GlobalStats | null;
      if (groupStats) this.applyStats(groupStats);

      const completedTransfers = await this.loadCompletedTransfers(groupName);
      if (completedTransfers) this.liveCompletedTransfers.set(completedTransfers);
    } catch (error) {
      console.error('Error fetching group stats:', error);
    }
  }

  private async loadCompletedTransfers(group: string): Promise<CompletedTransfer[] | null> {
    try {
      const response = (await this.jobService.getCompletedTransfers(group)) as
        | { transferred?: RawTransfer[] }
        | RawTransfer[]
        | null;
      const transfers = (response as { transferred?: RawTransfer[] })?.transferred ?? response;
      if (!Array.isArray(transfers)) return null;
      return (transfers as RawTransfer[]).map(t => this.mapTransfer(t));
    } catch {
      return null;
    }
  }

  private applyStats(stats: GlobalStats): void {
    const lastError = (stats.lastError ?? '').trim();
    if (lastError) {
      this.errorHistory.update(prev =>
        prev.includes(lastError) ? prev : [lastError, ...prev].slice(0, 20)
      );
    }

    this.trackCompletedFiles(stats);

    const active = (stats.transferring ?? []).map(f => {
      const percentage = f.size > 0 ? Math.min(100, Math.round((f.bytes / f.size) * 100)) : 0;
      return {
        ...f,
        percentage,
        isError: f.bytes < f.size && percentage === 100,
        isCompleted: false,
      };
    });
    this.liveActiveTransfers.set(active);
    this.liveGroupStats.set({ ...stats, transferring: active });
  }

  private trackCompletedFiles(stats: GlobalStats): void {
    const currentCount = stats.transfers ?? 0;
    if (currentCount <= this.lastTransferCount) return;

    const activeNames = new Set(stats.transferring?.map(f => f.name) ?? []);
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
        action: 'copy',
      }));

    if (newCompletions.length > 0) {
      this.liveCompletedTransfers.update(prev => {
        const unique = newCompletions.filter(nc => !prev.some(p => p.name === nc.name));
        return [...unique, ...prev].slice(0, 50);
      });
    }
    this.lastTransferCount = currentCount;
  }

  private mapTransfer(t: RawTransfer): CompletedTransfer {
    let status: CompletedTransfer['status'] = 'completed';
    if (t.error) status = 'failed';
    else if (t.checked) status = 'checked';
    else if (t.bytes != null && t.size != null && t.bytes > 0 && t.bytes < t.size)
      status = 'partial';

    return {
      name: t.name ?? '',
      size: t.size ?? 0,
      bytes: t.bytes ?? 0,
      checked: t.checked ?? false,
      error: t.error ?? '',
      jobid: t.group ? parseInt(t.group.replace('job/', '')) : 0,
      startedAt: t.started_at,
      completedAt: t.completed_at,
      srcFs: t.srcFs,
      dstFs: t.dstFs,
      group: t.group,
      status,
    };
  }

  private resetTransfers(): void {
    this.liveActiveTransfers.set([]);
    this.liveCompletedTransfers.set([]);
    this.errorHistory.set([]);
    this.lastTransferCount = 0;
    this.liveGroupStats.set(null);
  }

  private formatProgress(): string {
    const { bytes, totalBytes } = this.jobStats();
    return totalBytes > 0
      ? `${this.formatFileSize.transform(bytes)} / ${this.formatFileSize.transform(totalBytes)}`
      : this.formatFileSize.transform(bytes);
  }
}

function parseDateValue(value?: string | null): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
