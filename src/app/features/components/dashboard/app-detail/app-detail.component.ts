import { NgClass, TitleCasePipe } from '@angular/common';
import {
  Component,
  EventEmitter,
  Output,
  inject,
  signal,
  computed,
  effect,
  input,
  untracked,
  model,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslateService, TranslateModule } from '@ngx-translate/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDividerModule } from '@angular/material/divider';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
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
  SENSITIVE_KEYS,
  ServeListItem,
  SettingsPanelConfig,
  StatsPanelConfig,
  SyncOperation,
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
    MatChipsModule,
    MatButtonModule,
    MatButtonToggleModule,
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
  templateUrl: './app-detail.component.html',
  styleUrls: ['./app-detail.component.scss'],
})
export class AppDetailComponent {
  // --- Signal Inputs ---
  mainOperationType = input<PrimaryActionType>('mount');
  selectedSyncOperation = model<SyncOperationType>('sync');
  selectedRemote = input.required<Remote>();
  remoteSettings = input<RemoteSettings>({});
  actionInProgress = input<ActionState[] | null | undefined>(null);

  // --- Outputs ---
  @Output() syncOperationChange = new EventEmitter<SyncOperationType>();
  @Output() openRemoteConfigModal = new EventEmitter<{
    editTarget?: string;
    existingConfig?: RemoteSettings;
    initialSection?: string;
    targetProfile?: string;
    remoteType?: string;
  }>();
  @Output() openInFiles = new EventEmitter<{ remoteName: string; path: string }>();
  @Output() startJob = new EventEmitter<{
    type: PrimaryActionType;
    remoteName: string;
    profileName?: string;
  }>();
  @Output() stopJob = new EventEmitter<{
    type: PrimaryActionType;
    remoteName: string;
    profileName?: string;
    serveId?: string;
  }>();

  // --- Services ---
  private readonly jobService = inject(JobManagementService);
  readonly iconService = inject(IconService);
  private readonly translate = inject(TranslateService);
  private readonly langChange = signal<unknown | null>(null);
  private readonly formatFileSize = new FormatFileSizePipe();
  private readonly formatTime = new FormatTimePipe();

  private readonly systemInfoService = inject(SystemInfoService);

  // --- State Signals ---
  // Group-based stats (e.g., 'sync/gdrive' for all sync jobs on gdrive remote)
  private groupStats = signal<GlobalStats | null>(null);
  // Use group stats if available, otherwise show empty stats (no global fallback)
  jobStats = computed(() => this.groupStats() ?? DEFAULT_JOB_STATS);

  isLoading = signal(false);
  activeTransfers = signal<TransferFile[]>([]);
  completedTransfers = signal<CompletedTransfer[]>([]);

  // --- Internal State ---
  private lastTransferCount = 0;
  private lastGroupName?: string;

  /**
   * Reset stats for the current group
   * This clears the "Completed Transfers" list and resets aggregated stats
   */
  async onResetStats(): Promise<void> {
    const groupName = this.currentGroupName();
    if (groupName) {
      try {
        await this.jobService.resetGroupStats(groupName);
        this.resetTransfers();
        this.fetchGroupData(groupName);
      } catch (error) {
        console.error('Failed to reset group stats:', error);
      }
    }
  }

  // --- Constants ---
  readonly POLL_INTERVAL_MS = 1000;

  // Derived from OPERATION_METADATA to avoid duplicating label/icon/cssClass/description.
  readonly syncOperations: SyncOperation[] = (['sync', 'bisync', 'move', 'copy'] as const).map(
    type => ({ type, ...OPERATION_METADATA[type] })
  );

  selectedProfile = signal<string | null>(null);

  profiles = computed<{ name: string; label: string }[]>(() => {
    this.langChange(); // Dependency on language change
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

    if (profileNames.length > 0) {
      return profileNames.map(name => ({ name, label: name }));
    }

    // No profiles exist, return default
    return [{ name: 'default', label: this.translate.instant('dashboard.appDetail.default') }];
  });

  // Enriched profiles with status information
  enrichedProfiles = computed(() => {
    const profiles = this.profiles();
    // Reuses currentOpType() instead of inlining the ternary again
    const opType = this.currentOpType();

    const configs = this.getProfileConfigs(opType) as
      | Record<string, { cronEnabled?: boolean; cronExpression?: string | null }>
      | undefined;

    return profiles.map(p => {
      const config = configs?.[p.name];
      const isActive = this.isProfileActive(opType, p.name);
      const hasSchedule = !!(config?.cronEnabled && config?.cronExpression);

      return {
        ...p,
        isActive,
        hasSchedule,
        status: isActive ? 'running' : hasSchedule ? 'scheduled' : 'idle',
      };
    });
  });

  // Show profile selector only when there are 2+ profiles
  showProfileSelector = computed(() => this.profiles().length > 1);

  constructor() {
    this.translate.onLangChange.pipe(takeUntilDestroyed()).subscribe(val => {
      this.langChange.set(val);
    });

    // 1. Polling Effect - Uses group-based stats
    effect(onCleanup => {
      const isActive = this.operationActiveState();
      const groupName = this.currentGroupName();

      if (isActive && groupName) {
        const timer = setInterval(() => {
          this.fetchGroupData(groupName);
        }, this.POLL_INTERVAL_MS);

        onCleanup(() => {
          clearInterval(timer);
        });
      } else {
        untracked(() => {
          if (this.activeTransfers().length > 0) {
            this.activeTransfers.set([]);
          }
        });
      }
    });

    // 2. Group Name Change Reset Effect
    effect(() => {
      const groupName = this.currentGroupName();
      untracked(() => {
        if (groupName !== this.lastGroupName) {
          this.lastGroupName = groupName;
          this.resetTransfers();
        }
      });
    });

    // 3. Auto-select profile effect
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

  // --- Helper Methods for State Access ---

  /** Get operation state from remote */
  private getOperationState(
    type: SyncOperationType | 'mount' | 'serve'
  ): RemoteOperationState | RemoteServeState | null {
    const remote = this.selectedRemote();
    if (!remote) return null;
    return remote.status[type as keyof Omit<RemoteStatus, 'diskUsage'>];
  }

  /** Check if a profile is active for an operation type */
  private isProfileActive(type: string, profileName?: string): boolean {
    const state = this.getOperationState(type as SyncOperationType | 'mount' | 'serve');
    if (!state) return false;

    if (type === 'serve') {
      const serveState = state as RemoteStatus['serve'];
      const serves = serveState?.serves || [];
      return profileName ? serves.some(s => s.profile === profileName) : !!serveState?.active;
    }

    if (type === 'mount') {
      const mountState = state as RemoteStatus['mount'];
      return profileName ? !!mountState?.activeProfiles?.[profileName] : !!mountState?.active;
    }

    if (['sync', 'copy', 'move', 'bisync'].includes(type)) {
      // These states all share the same structure regarding activeProfiles
      const opState = state as RemoteStatus['sync' | 'copy' | 'move' | 'bisync'];
      if (profileName) {
        return !!opState?.activeProfiles?.[profileName];
      }
      return !!opState?.active;
    }

    return false;
  }

  /** Get profile configs for an operation type */
  private getProfileConfigs(type: string): Record<string, any> | undefined {
    const settings = this.remoteSettings();
    const configKey = REMOTE_CONFIG_KEYS[type as keyof typeof REMOTE_CONFIG_KEYS];
    return settings[configKey as keyof RemoteSettings] as Record<string, any> | undefined;
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
      // Always show at least one section for the type
      sections.push({
        key: type,
        title: titlePrefix,
        icon,
        group,
      });
    }
  }

  // --- Computed Signals ---

  remoteName = computed(() => this.selectedRemote().name);

  /** Filters running serves to only show those belonging to the selected remote */
  filteredRunningServes = computed(() => {
    return (this.selectedRemote().status.serve?.serves || []) as ServeListItem[];
  });

  isSyncType = computed(() => this.mainOperationType() === 'sync');

  currentOpType = computed(() =>
    this.isSyncType() ? this.selectedSyncOperation() : this.mainOperationType()
  );

  currentOpMetadata = computed(() => OPERATION_METADATA[this.currentOpType()]);

  // currentOperation removed: currentOpMetadata() exposes the same label/icon
  // that statsConfig needs, without an extra .find() over syncOperations.

  operationActiveState = computed(() => {
    // Reuses currentOpType() instead of inlining the ternary
    return this.isProfileActive(this.currentOpType());
  });

  jobId = computed(() => {
    if (!this.isSyncType()) return undefined;
    const op = this.selectedSyncOperation();
    const profileName = this.selectedProfile() || 'default';
    const state = this.getOperationState(op) as RemoteOperationState;
    // Cast to syncState as we know op is partial SyncOperationType and all sync states have activeProfiles
    return state?.activeProfiles?.[profileName];
  });

  /** Generate the group name for the current operation (e.g., 'sync/gdrive') */
  currentGroupName = computed(() => {
    // Reuses currentOpType() instead of inlining the ternary
    const opType = this.currentOpType();
    const profile = this.selectedProfile();

    if (profile) {
      return `${opType}/${this.remoteName()}/${profile}`;
    }
    return `${opType}/${this.remoteName()}`;
  });

  operationSettingsSections = computed<RemoteSettingsSection[]>(() => {
    this.langChange(); // Dependency
    const sections: RemoteSettingsSection[] = [];
    const settings = this.remoteSettings();
    const metadata = this.currentOpMetadata();
    const type = this.currentOpType();

    if (metadata) {
      const title = this.translate.instant('dashboard.appDetail.settingsLabel', {
        op: this.translate.instant(metadata.label),
      });
      this.addSettingsSections(sections, settings, type, title, metadata.icon, 'operation');
    }

    return sections;
  });

  sharedSettingsSections = computed<RemoteSettingsSection[]>(() => {
    const sections: RemoteSettingsSection[] = [];
    const settings = this.remoteSettings();
    const metadata = this.currentOpMetadata();

    // VFS is only relevant for operations that support it
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

    // Runtime remote overrides are relevant for sync types
    if (this.isSyncType()) {
      const runtimeMeta = OPERATION_METADATA['runtimeRemote'];
      this.addSettingsSections(
        sections,
        settings,
        'runtimeRemote',
        this.translate.instant(runtimeMeta.label),
        runtimeMeta.icon,
        'shared'
      );
    }

    return sections;
  });

  operationSettingsHeading = computed(() => {
    const metadata = this.currentOpMetadata();
    if (!metadata) return '';

    const count = this.operationSettingsSections().length;
    const opLabel = this.translate.instant(metadata.label);

    if (count > 1) {
      return this.translate.instant('dashboard.appDetail.profilesLabel', { op: opLabel });
    }
    return this.translate.instant('dashboard.appDetail.settingsLabel', { op: opLabel });
  });

  operationSettingsDescription = computed(() => {
    const metadata = this.currentOpMetadata();
    return metadata?.description ? this.translate.instant(metadata.description) : '';
  });

  // --- Configuration Generators (Computed) ---

  unifiedControlConfigs = computed<OperationControlConfig[]>(() => {
    const type = this.currentOpType() as PrimaryActionType;
    const metadata = this.currentOpMetadata();
    const settings = this.remoteSettings();
    const configKey = REMOTE_CONFIG_KEYS[type as keyof typeof REMOTE_CONFIG_KEYS];

    if (!configKey || !metadata) return [];

    const profiles = settings[configKey as keyof RemoteSettings] as Record<string, any> | undefined;
    const profileEntries = profiles ? Object.entries(profiles) : [];

    // If we have profiles, create a config for each
    if (profileEntries.length > 0) {
      return profileEntries.map(([profileName, profile]) =>
        this.createUnifiedControlConfig(type, profile, profileName)
      );
    }

    // Always show at least one default config even if no profiles exist
    return [this.createUnifiedControlConfig(type, {}, undefined)];
  });

  private createUnifiedControlConfig(
    type: PrimaryActionType,
    config: any,
    profileName?: string
  ): OperationControlConfig {
    const metadata = OPERATION_METADATA[type];
    const isActive = this.isProfileActive(type, profileName);
    const inProgressActions = this.actionInProgress();

    // Check for in-progress actions for this specific type/profile
    const actionMatch = inProgressActions?.find(
      a =>
        (a.type === type || (type === 'mount' && a.type === 'unmount')) &&
        (a.profileName === profileName || (!a.profileName && !profileName))
    );
    const actionType = actionMatch?.type;
    const isLoading = this.isLoading() || !!actionType;

    // Path Config specialization
    let pathConfig: PathDisplayConfig;
    if (type === 'serve') {
      const serveType = (config?.options?.type as string) || 'http';
      const serveAddr =
        (config?.options?.addr as string) || this.translate.instant('dashboard.appDetail.default');
      pathConfig = {
        source: config.source || `${this.selectedRemote().name}:`,
        destination: `${serveType.toUpperCase()} at ${serveAddr}`,
        sourceLabel: this.translate.instant('dashboard.appDetail.serving'),
        destinationLabel: this.translate.instant('dashboard.appDetail.accessibleVia'),
        showOpenButtons: false,
        operationColor: metadata.cssClass as any,
        isDestinationActive: isActive,
      };
    } else {
      pathConfig = {
        source: config.source || this.translate.instant('dashboard.appDetail.notConfigured'),
        destination:
          config.dest ||
          config.destination ||
          this.translate.instant('dashboard.appDetail.notConfigured'),
        showOpenButtons: true,
        operationColor: metadata.cssClass as any,
        isDestinationActive: type === 'mount' ? isActive : true,
        actionInProgress: (actionType as RemoteAction) || undefined,
      };
    }

    return {
      operationType: type,
      isActive,
      isLoading,
      cssClass: metadata.cssClass,
      pathConfig,
      primaryButtonLabel: isLoading
        ? this.translate.instant('dashboard.appDetail.starting', {
            op: this.translate.instant(metadata.label),
          })
        : this.translate.instant('dashboard.appDetail.start', {
            op: this.translate.instant(metadata.label),
          }),
      secondaryButtonLabel: isLoading
        ? this.translate.instant('dashboard.appDetail.stopping', {
            op: this.translate.instant(metadata.label),
          })
        : this.translate.instant('dashboard.appDetail.stop', {
            op: this.translate.instant(metadata.label),
          }),
      primaryIcon: metadata.icon,
      secondaryIcon: type === 'mount' ? 'eject' : 'stop',
      actionInProgress: (actionType as RemoteAction) || undefined,
      operationDescription: metadata.description
        ? this.translate.instant(metadata.description)
        : undefined,
      profileName,
    };
  }

  jobInfoConfig = computed<JobInfoConfig>(() => {
    // Read once and reuse to avoid double signal subscription
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
      showProfileSelector: profiles.length > 1,
    };
  });

  statsConfig = computed<StatsPanelConfig>(() => {
    const statsData = this.jobStats();
    const progress = this.calculateProgress();
    // Uses currentOpMetadata() directly; currentOperation() computed was removed
    // as it was a redundant .find() over syncOperations for the same data.
    const meta = this.currentOpMetadata();

    const etaProgress =
      statsData.elapsedTime && statsData.eta
        ? (statsData.elapsedTime / (statsData.elapsedTime + statsData.eta)) * 100
        : 0;

    return {
      title: this.translate.instant('dashboard.appDetail.transferStatistics', {
        op: meta ? this.translate.instant(meta.label) : 'Transfer',
      }),
      icon: meta?.icon || 'bar_chart',
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

  transferActivityConfig = computed<TransferActivityPanelConfig>(() => {
    // Read once and reuse to avoid double signal subscription
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

  // --- Helper Computeds ---
  operationClass = computed(() => {
    const type = this.currentOpType();
    return this.isSyncType() ? `sync-${type}-operation` : `${type}-operation`;
  });

  operationColor = computed(() => {
    const metadata = this.currentOpMetadata();
    return (
      (metadata?.cssClass as 'primary' | 'accent' | 'yellow' | 'orange' | 'purple') || 'primary'
    );
  });

  // Cron schedules for all profiles of the current sync operation
  cronSchedules = computed<
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
          // Keep default value
        }
        schedules.push({
          profileName,
          cronExpression: config.cronExpression,
          humanReadable,
        });
      }
    }

    return schedules;
  });

  // Cron schedule for the selected profile only
  selectedCronSchedule = computed(() => {
    const schedules = this.cronSchedules();
    const selected = this.selectedProfile();

    // If no profile is selected, return first schedule
    if (!selected) return schedules[0] || null;

    return schedules.find(s => s.profileName === selected) || null;
  });

  hasCronSchedule = computed(() => this.selectedCronSchedule() !== null);

  filteredControlConfigs = computed(() => {
    const configs = this.unifiedControlConfigs();
    const selected = this.selectedProfile();

    // If no profile selector or only one config, show all
    if (!this.showProfileSelector() || configs.length <= 1) {
      return configs;
    }

    // Filter by selected profile
    return configs.filter(c => c.profileName === selected);
  });

  // --- Public Methods ---

  onSyncOperationChange(operation: SyncOperationType): void {
    this.selectedSyncOperation.set(operation);
    this.syncOperationChange.emit(operation);
  }

  triggerOpenInFiles(path: string): void {
    // selectedRemote is input.required<Remote>() so it is never null/undefined
    const name = this.selectedRemote().name;
    if (name) {
      this.openInFiles.emit({ remoteName: name, path });
    }
  }

  async onCopyToClipboard(event: { text: string; message: string }): Promise<void> {
    try {
      await navigator.clipboard.writeText(event.text);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
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

  getSettingsPanelConfig(section: RemoteSettingsSection): SettingsPanelConfig {
    const [key, profileName] = section.key.split(':');
    const settings = this.remoteSettings() as Record<string, any>;

    // configKey resolved once and shared across both branches (was duplicated before)
    const configKey = REMOTE_CONFIG_KEYS[
      key as keyof typeof REMOTE_CONFIG_KEYS
    ] as keyof RemoteSettings;
    const profiles = settings[configKey] as Record<string, any> | undefined;

    let specificSettings: Record<string, any>;

    if (profileName) {
      specificSettings = profiles?.[profileName] ?? {};
    } else if (
      profiles &&
      (key === 'sync' || key === 'bisync' || key === 'move' || key === 'copy')
    ) {
      // For profile-based operations, fall back to 'default' or first entry
      specificSettings = profiles['default'] ?? Object.values(profiles)[0] ?? {};
    } else {
      // For single-config/shared operations (vfs, filter, etc.)
      specificSettings = profiles ?? {};
    }

    return {
      section,
      settings: specificSettings,
      hasSettings: Object.keys(specificSettings).length > 0,
      buttonColor: this.operationColor(),
      buttonLabel: undefined,
      sensitiveKeys: SENSITIVE_KEYS,
    };
  }

  shouldShowCharts = computed(() => this.isSyncType());

  // --- Data Fetching Logic (Polling) ---

  private async fetchGroupData(groupName: string): Promise<void> {
    try {
      const [groupStats, completedTransfers] = await Promise.all([
        this.systemInfoService.getStats(groupName) as Promise<GlobalStats | null>,
        this.loadCompletedTransfers(groupName),
      ]);

      if (groupStats) {
        this.updateStatsSignals(groupStats);
      }

      if (completedTransfers) {
        this.completedTransfers.set(completedTransfers);
      }
    } catch (error) {
      console.error('Error fetching group stats:', error);
    }
  }

  private async loadCompletedTransfers(group: string): Promise<CompletedTransfer[] | null> {
    try {
      const response: any = await this.jobService.getCompletedTransfers(group);
      const transfers = response?.transferred || response;
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

    // Update group stats
    this.groupStats.set({ ...stats, transferring });
  }

  // --- Logic Helpers ---

  private processTransfers(files: any[] = []): TransferFile[] {
    return files.map(f => ({
      ...f,
      percentage: f.size > 0 ? Math.min(100, Math.round((f.bytes / f.size) * 100)) : 0,
      isError: f.bytes < f.size && f.percentage === 100,
      isCompleted: false,
    }));
  }

  private trackCompletedFiles(stats: GlobalStats): void {
    const currentCount = stats.transfers || 0;

    if (currentCount > this.lastTransferCount) {
      const activeNames = new Set(stats.transferring?.map((f: TransferFile) => f.name) || []);
      const currentActive = this.activeTransfers();

      const newCompletions: CompletedTransfer[] = [];

      currentActive.forEach(file => {
        if (!activeNames.has(file.name) && file.percentage > 0 && file.percentage < 100) {
          const completed: CompletedTransfer = {
            ...file,
            checked: false,
            error: '',
            jobid: Number(this.jobId() ?? 0),
            status: 'completed',
            startedAt: undefined,
            completedAt: new Date().toISOString(),
            srcFs: undefined,
            dstFs: undefined,
            group: undefined,
          };
          newCompletions.push(completed);
        }
      });

      if (newCompletions.length > 0) {
        this.completedTransfers.update(prev => {
          const uniqueNew = newCompletions.filter(nc => !prev.some(p => p.name === nc.name));
          return [...uniqueNew, ...prev].slice(0, 50);
        });
      }

      this.lastTransferCount = currentCount;
    }
  }

  private mapTransfer(transfer: any): CompletedTransfer {
    let status: 'completed' | 'checked' | 'failed' | 'partial' = 'completed';
    if (transfer.error) status = 'failed';
    else if (transfer.checked) status = 'checked';
    else if (transfer.bytes > 0 && transfer.bytes < transfer.size) status = 'partial';

    return {
      name: transfer.name || '',
      size: transfer.size || 0,
      bytes: transfer.bytes || 0,
      checked: transfer.checked || false,
      error: transfer.error || '',
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
    // Clear group stats so it falls back to global stats from service
    this.groupStats.set(null);
  }

  // --- Stats Formatting Helpers ---

  private formatProgress(): string {
    const { bytes, totalBytes } = this.jobStats();
    if (totalBytes > 0) {
      return `${this.formatFileSize.transform(bytes)} / ${this.formatFileSize.transform(totalBytes)}`;
    }
    return this.formatFileSize.transform(bytes);
  }

  formatSpeed(speed: number): string {
    return `${this.formatFileSize.transform(speed)}/s`;
  }

  calculateProgress(): number {
    const { bytes, totalBytes } = this.jobStats();
    return totalBytes > 0 ? Math.min(100, (bytes / totalBytes) * 100) : 0;
  }
}
