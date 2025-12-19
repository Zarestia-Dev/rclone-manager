import { CommonModule } from '@angular/common';
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
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDividerModule } from '@angular/material/divider';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatTabsModule } from '@angular/material/tabs';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { FormatTimePipe } from 'src/app/shared/pipes/format-time.pipe';
import { FormatFileSizePipe } from 'src/app/shared/pipes/format-file-size.pipe';
import {
  ActionState,
  CompletedTransfer,
  DEFAULT_JOB_STATS,
  GlobalStats,
  JobInfoConfig,
  OperationControlConfig,
  PathDisplayConfig,
  PrimaryActionType,
  Remote,
  RemoteSettings,
  RemoteSettingsSection,
  SENSITIVE_KEYS,
  ServeListItem,
  SettingsPanelConfig,
  StatItem,
  StatsPanelConfig,
  SyncOperation,
  SyncOperationType,
  TransferActivityPanelConfig,
  TransferFile,
} from '@app/types';
import {
  JobInfoPanelComponent,
  OperationControlComponent,
  SettingsPanelComponent,
  StatsPanelComponent,
  TransferActivityPanelComponent,
} from '../../../../shared/detail-shared';
import { ServeCardComponent } from '../../../../shared/components/serve-card/serve-card.component';
import { IconService } from '../../../../shared/services/icon.service';
import { JobManagementService } from '@app/services';
import { toString as cronstrue } from 'cronstrue';
import { VfsControlPanelComponent } from '../../../../shared/detail-shared/vfs-control/vfs-control-panel.component';

@Component({
  selector: 'app-app-detail',
  standalone: true,
  imports: [
    CommonModule,
    MatIconModule,
    MatTooltipModule,
    MatDividerModule,
    MatCardModule,
    MatChipsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatTabsModule,
    MatProgressSpinnerModule,
    MatProgressBarModule,
    OperationControlComponent,
    JobInfoPanelComponent,
    StatsPanelComponent,
    SettingsPanelComponent,
    TransferActivityPanelComponent,
    VfsControlPanelComponent,
    ServeCardComponent,
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
  restrictMode = input<boolean>(false);
  actionInProgress = input<ActionState[] | null | undefined>(null);
  runningServes = input<ServeListItem[]>([]);

  // --- Outputs ---
  @Output() syncOperationChange = new EventEmitter<SyncOperationType>();
  @Output() openRemoteConfigModal = new EventEmitter<{
    editTarget?: string;
    existingConfig?: RemoteSettings;
    initialSection?: string;
    targetProfile?: string;
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
  private readonly formatFileSize = new FormatFileSizePipe();
  private readonly formatTime = new FormatTimePipe();

  // --- State Signals ---
  jobStats = signal<GlobalStats>({ ...DEFAULT_JOB_STATS });
  isLoading = signal(false);
  activeTransfers = signal<TransferFile[]>([]);
  completedTransfers = signal<CompletedTransfer[]>([]);

  // --- Internal State ---
  private lastTransferCount = 0;
  private lastJobId?: number;

  // --- Constants ---
  readonly POLL_INTERVAL_MS = 1000;
  readonly sharedSettingsHeading = 'Shared Settings';
  readonly sharedSettingsDescription =
    'Applies to all operations, regardless of sync or mount mode.';
  readonly syncOperations: SyncOperation[] = [
    {
      type: 'sync',
      label: 'Sync',
      icon: 'refresh',
      cssClass: 'primary',
      description: 'One-way synchronization',
    },
    {
      type: 'bisync',
      label: 'BiSync',
      icon: 'right-left',
      cssClass: 'purple',
      description: 'Bidirectional sync',
    },
    {
      type: 'move',
      label: 'Move',
      icon: 'move',
      cssClass: 'orange',
      description: 'Move files (delete source)',
    },
    {
      type: 'copy',
      label: 'Copy',
      icon: 'copy',
      cssClass: 'yellow',
      description: 'Copy files (keep source)',
    },
  ];

  selectedProfile = signal<string | null>(null);

  profiles = computed<{ name: string; label: string }[]>(() => {
    const settings = this.remoteSettings();
    let configKey: string;

    // Determine which config to use based on operation type
    if (this.isSyncType()) {
      configKey = `${this.selectedSyncOperation()}Configs`;
    } else if (this.mainOperationType() === 'mount') {
      configKey = 'mountConfigs';
    } else if (this.mainOperationType() === 'serve') {
      configKey = 'serveConfigs';
    } else {
      return [{ name: 'default', label: 'Default' }];
    }

    const configProfiles = settings[configKey as keyof RemoteSettings] as
      | Record<string, unknown>
      | undefined;
    const profileNames = configProfiles ? Object.keys(configProfiles) : [];

    if (profileNames.length > 0) {
      return profileNames.map(name => ({ name, label: name }));
    }

    // No profiles exist, return default
    return [{ name: 'default', label: 'Default' }];
  });

  // Enriched profiles with status information
  enrichedProfiles = computed(() => {
    const profiles = this.profiles();
    const opType = this.isSyncType() ? this.selectedSyncOperation() : this.mainOperationType();

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
    // 1. Polling Effect
    effect(onCleanup => {
      const isActive = this.operationActiveState();
      const jobId = this.jobId();
      const remoteName = this.remoteName();

      if (isActive && jobId && remoteName) {
        const timer = setInterval(() => {
          this.fetchJobData(jobId, remoteName);
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

    // 2. Job ID Change Reset Effect
    effect(() => {
      const id = this.jobId();
      untracked(() => {
        if (id !== this.lastJobId) {
          this.lastJobId = id;
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
  private getOperationState(type: SyncOperationType | 'mount' | 'serve'): any {
    const remote = this.selectedRemote();
    const stateMap: Record<string, any> = {
      sync: remote?.syncState,
      bisync: remote?.bisyncState,
      move: remote?.moveState,
      copy: remote?.copyState,
      mount: remote?.mountState,
      serve: remote?.serveState,
    };
    return stateMap[type];
  }

  /** Check if a profile is active for an operation type */
  private isProfileActive(type: string, profileName?: string): boolean {
    if (type === 'serve') {
      const remote = this.selectedRemote();
      const serves = this.runningServes();
      return profileName
        ? serves.some(
            s => s.params.fs.startsWith(remote.remoteSpecs.name + ':') && s.profile === profileName
          )
        : serves.some(s => s.params.fs.startsWith(remote.remoteSpecs.name + ':'));
    }

    const state = this.getOperationState(type as SyncOperationType | 'mount');
    if (!state) return false;

    if (type === 'mount') {
      return profileName ? !!state.activeProfiles?.[profileName] : !!state.mounted;
    }

    // Sync types
    const isActiveKey = `isOn${type.charAt(0).toUpperCase() + type.slice(1)}`;
    return profileName ? !!state.activeProfiles?.[profileName] : !!state[isActiveKey];
  }

  /** Get profile configs for an operation type */
  private getProfileConfigs(type: string): Record<string, any> | undefined {
    const settings = this.remoteSettings();
    return settings[`${type}Configs` as keyof RemoteSettings] as Record<string, any> | undefined;
  }

  // --- Computed Signals ---

  remoteName = computed(() => this.selectedRemote().remoteSpecs.name);

  isSyncType = computed(() => this.mainOperationType() === 'sync');

  currentOperation = computed(
    () => this.syncOperations.find(op => op.type === this.selectedSyncOperation()) || null
  );

  operationActiveState = computed(() => {
    const type = this.isSyncType() ? this.selectedSyncOperation() : this.mainOperationType();
    return this.isProfileActive(type);
  });

  jobId = computed(() => {
    if (!this.isSyncType()) return undefined;
    const op = this.selectedSyncOperation();
    const profileName = this.selectedProfile() || 'default';
    return this.getOperationState(op)?.activeProfiles?.[profileName];
  });

  operationSettingsSections = computed<RemoteSettingsSection[]>(() => {
    const sections: RemoteSettingsSection[] = [];
    const settings = this.remoteSettings();

    // Helper to add operation profile sections
    const addProfileSections = (type: string, titlePrefix: string, icon: string): void => {
      const profiles = settings[`${type}Configs` as keyof RemoteSettings] as
        | Record<string, unknown>
        | undefined;
      const profileNames = profiles ? Object.keys(profiles) : [];

      if (profileNames.length > 0) {
        profileNames.forEach(profileName => {
          sections.push({
            key: `${type}:${profileName}`,
            title: `${titlePrefix} (${profileName})`,
            icon,
            group: 'operation',
          });
        });
      } else {
        // Always show at least one default section
        sections.push({
          key: type,
          title: titlePrefix,
          icon,
          group: 'operation',
        });
      }
    };

    if (this.isSyncType()) {
      const type = this.selectedSyncOperation();
      const op = this.currentOperation();
      addProfileSections(type, `${op?.label || 'Sync'} Options`, op?.icon || 'gear');
    } else if (this.mainOperationType() === 'serve') {
      addProfileSections('serve', 'Protocol Options', 'satellite-dish');
    } else {
      addProfileSections('mount', 'Mount Options', 'gear');
    }

    return sections;
  });

  sharedSettingsSections = computed<RemoteSettingsSection[]>(() => {
    const sections: RemoteSettingsSection[] = [];
    const settings = this.remoteSettings();
    const operationType = this.mainOperationType();

    // Helper to add sections for a type
    const addSections = (type: string, titlePrefix: string, icon: string): void => {
      const profiles = settings[`${type}Configs` as keyof RemoteSettings] as
        | Record<string, unknown>
        | undefined;
      const profileNames = profiles ? Object.keys(profiles) : [];

      if (profileNames.length > 0) {
        profileNames.forEach(profileName => {
          sections.push({
            key: `${type}:${profileName}`,
            title: `${titlePrefix} (${profileName})`,
            icon,
            group: 'shared',
          });
        });
      } else {
        sections.push({
          key: type,
          title: titlePrefix,
          icon,
          group: 'shared',
        });
      }
    };

    // VFS is only relevant for mount and serve operations
    if (operationType === 'mount' || operationType === 'serve') {
      addSections('vfs', 'VFS Options', 'vfs');
    }

    addSections('filter', 'Filter Options', 'filter');
    addSections('backend', 'Backend Config', 'server');

    return sections;
  });

  operationSettingsHeading = computed(() => {
    if (this.isSyncType()) {
      const op = this.currentOperation();
      const count = this.operationSettingsSections().length;
      return count > 1 ? `${op?.label || 'Sync'} Profiles` : `${op?.label || 'Sync'} Settings`;
    } else if (this.mainOperationType() === 'serve') {
      return this.operationSettingsSections().filter(s => s.group === 'operation').length > 1
        ? 'Serve Profiles'
        : 'Serve Settings';
    }
    return this.operationSettingsSections().length > 2 ? 'Mount Profiles & VFS' : 'Mount Settings';
  });

  operationSettingsDescription = computed(() => {
    if (this.isSyncType()) {
      const op = this.currentOperation();
      return `Adjust how the ${op?.label?.toLowerCase() || 'sync'} process behaves. Multi-profile supported.`;
    } else if (this.mainOperationType() === 'serve') {
      return 'Configure serving protocols (HTTP, FTP, etc). Multi-profile supported.';
    }
    return 'Configure mount behavior and virtual file system tuning.';
  });

  // --- Configuration Generators (Computed) ---

  operationControlConfigs = computed<OperationControlConfig[]>(() => {
    const op = this.currentOperation();
    const type = this.isSyncType()
      ? (this.selectedSyncOperation() as PrimaryActionType)
      : this.mainOperationType();
    const settings = this.remoteSettings();
    const profiles = settings[`${type}Configs` as keyof RemoteSettings] as
      | Record<string, unknown>
      | undefined;
    const profileEntries = profiles ? Object.entries(profiles) : [];

    // If we have profiles, create a config for each
    if (profileEntries.length > 0) {
      return profileEntries.map(([profileName, profile]) =>
        this.createOperationControlConfig(
          type,
          op,
          this.getPathConfigForProfile(profile),
          profileName
        )
      );
    }

    // Always show at least one default config even if no profiles exist
    return [
      this.createOperationControlConfig(
        type,
        op,
        {
          source: 'Not configured',
          destination: 'Not configured',
          showOpenButtons: true,
          isDestinationActive: true,
        },
        undefined
      ),
    ];
  });

  private createOperationControlConfig(
    type: PrimaryActionType,
    op: SyncOperation | null,
    pathConfig: PathDisplayConfig,
    profileName?: string
  ): OperationControlConfig {
    const remote = this.selectedRemote();
    let isActive = false;

    if (this.isSyncType()) {
      const stateMap: any = {
        sync: remote?.syncState,
        bisync: remote?.bisyncState,
        move: remote?.moveState,
        copy: remote?.copyState,
      };

      const state = stateMap[type];

      if (profileName && state?.activeProfiles) {
        isActive = !!state.activeProfiles[profileName];
      } else {
        const keyMap: any = {
          sync: 'isOnSync',
          bisync: 'isOnBisync',
          move: 'isOnMove',
          copy: 'isOnCopy',
        };
        isActive = !!state?.[keyMap[type]];
      }
    } else {
      isActive = !!remote?.mountState?.mounted;
    }

    const inProgressActions = this.actionInProgress();
    const actionMatch = inProgressActions?.find(
      a => a.type === type && (a.profileName === profileName || (!a.profileName && !profileName))
    );
    const inProgressType = actionMatch ? actionMatch.type : undefined;

    return {
      operationType: type,
      isActive,
      isLoading: this.isLoading() || !!actionMatch,
      cssClass: op?.cssClass || 'primary',
      pathConfig: pathConfig,
      primaryButtonLabel: this.isLoading() ? `Starting ${op?.label}...` : `Start ${op?.label}`,
      secondaryButtonLabel: this.isLoading() ? `Stopping ${op?.label}...` : `Stop ${op?.label}`,
      primaryIcon: op?.icon || 'play_arrow',
      secondaryIcon: 'stop',
      actionInProgress: inProgressType || undefined,
      operationDescription: op?.description,
      profileName: profileName,
    };
  }

  private getPathConfigForProfile(profile: any): PathDisplayConfig {
    return {
      source: (profile['source'] as string) || 'Not configured',
      destination: (profile['dest'] as string) || 'Not configured',
      showOpenButtons: true,
      isDestinationActive: true,
    };
  }

  mountControlConfigs = computed<OperationControlConfig[]>(() => {
    const settings = this.remoteSettings();
    const profiles = settings['mountConfigs'] as Record<string, unknown> | undefined;
    const profileEntries = profiles ? Object.entries(profiles) : [];

    if (profileEntries.length > 0) {
      return profileEntries.map(([profileName, p]) =>
        this.createMountControlConfig(p, profileName)
      );
    }

    // Always show at least one default config
    return [this.createMountControlConfig({}, undefined)];
  });

  private createMountControlConfig(config: any, profileName?: string): OperationControlConfig {
    const mountState = this.selectedRemote()?.mountState;
    const inProgressActions = this.actionInProgress();

    let isActive = false;
    if (profileName && mountState?.activeProfiles) {
      isActive = !!mountState.activeProfiles[profileName];
    } else {
      isActive = !!mountState?.mounted;
    }

    // Check specific mount action
    const actionMatch = inProgressActions?.find(
      a =>
        (a.type === 'mount' || a.type === 'unmount') &&
        (a.profileName === profileName || (!a.profileName && !profileName))
    );
    const actionType = actionMatch?.type;
    const isLoading = !!actionType;

    return {
      operationType: 'mount',
      isActive,
      isLoading,
      cssClass: 'accent',
      pathConfig: {
        source: config['source'] || 'Not configured',
        destination: config['dest'] || 'Not configured',
        showOpenButtons: true,
        operationColor: 'accent',
        isDestinationActive: isActive,
        actionInProgress: actionType || undefined,
      },
      primaryButtonLabel: actionType === 'mount' ? 'Mounting...' : 'Mount',
      primaryIcon: 'mount',
      secondaryButtonLabel: actionType === 'unmount' ? 'Unmounting...' : 'Unmount',
      secondaryIcon: 'eject',
      actionInProgress: actionType || undefined,
      profileName: profileName,
    };
  }

  serveControlConfigs = computed<OperationControlConfig[]>(() => {
    const settings = this.remoteSettings();
    const profiles = settings['serveConfigs'] as Record<string, unknown> | undefined;
    const profileEntries = profiles ? Object.entries(profiles) : [];

    if (profileEntries.length > 0) {
      return profileEntries.map(([profileName, p]) =>
        this.createServeControlConfig(p, profileName)
      );
    }

    // Always show at least one default config
    return [this.createServeControlConfig({}, undefined)];
  });

  private createServeControlConfig(config: any, profileName?: string): OperationControlConfig {
    const serves = this.runningServes();
    const remote = this.selectedRemote();

    let isActive = false;
    // Check if ANY serve matches this profile
    if (profileName) {
      isActive = serves.some(
        s => s.params.fs.startsWith(remote.remoteSpecs.name + ':') && s.profile === profileName
      );
    } else {
      // Legacy check: any serve for this remote
      isActive = serves.some(s => s.params.fs.startsWith(remote.remoteSpecs.name + ':'));
    }

    const inProgressActions = this.actionInProgress();
    const actionMatch = inProgressActions?.find(
      a => a.type === 'serve' && (a.profileName === profileName || (!a.profileName && !profileName))
    );

    // Extract source from config, fallback to remote name
    const source = (config?.source as string) || `${remote.remoteSpecs.name}:`;

    // Extract protocol type and address for destination display
    const serveType = (config?.options?.type as string) || 'http';
    const serveAddr = (config?.options?.addr as string) || 'Default';
    const destination = `${serveType.toUpperCase()} at ${serveAddr}`;

    return {
      operationType: 'serve',
      isActive,
      isLoading: !!actionMatch,
      cssClass: 'accent',
      pathConfig: {
        source: source,
        destination: destination,
        sourceLabel: 'Serving',
        destinationLabel: 'Accessible via',
        showOpenButtons: false,
        operationColor: 'accent',
        isDestinationActive: isActive,
      },
      primaryButtonLabel: 'Start Serve',
      primaryIcon: 'satellite-dish',
      secondaryButtonLabel: 'Stop Serve',
      secondaryIcon: 'stop',
      actionInProgress: actionMatch?.type || undefined,
      profileName: profileName,
    };
  }

  jobInfoConfig = computed<JobInfoConfig>(() => ({
    operationType: this.isSyncType()
      ? this.selectedSyncOperation()
      : (this.mainOperationType() ?? 'mount'),
    jobId: this.jobId(),
    startTime: this.jobStats().startTime ? new Date(this.jobStats().startTime!) : undefined,
    // Profile selection support
    profiles: this.profiles(),
    selectedProfile: this.selectedProfile() ?? undefined,
    showProfileSelector: this.profiles().length > 1,
  }));

  statsConfig = computed<StatsPanelConfig>(() => {
    const statsData = this.jobStats();
    const progress = this.calculateProgress();

    const etaProgress =
      statsData.elapsedTime && statsData.eta
        ? (statsData.elapsedTime / (statsData.elapsedTime + statsData.eta)) * 100
        : 0;

    const stats: StatItem[] = [
      {
        value: this.formatProgress(),
        label: 'Progress',
        isPrimary: true,
        progress,
      },
      {
        value: this.formatSpeed(statsData.speed || 0),
        label: 'Speed',
      },
      {
        value: this.formatTime.transform(statsData.eta),
        label: 'ETA',
        isPrimary: true,
        progress: etaProgress,
      },
      {
        value: `${statsData.transfers || 0}/${statsData.totalTransfers || 0}`,
        label: 'Files',
      },
      {
        value: statsData.errors || 0,
        label: 'Errors',
        hasError: (statsData.errors || 0) > 0,
        tooltip: statsData.lastError,
      },
      {
        value: this.formatTime.transform(statsData.elapsedTime),
        label: 'Duration',
      },
    ];

    const op = this.currentOperation();
    return {
      title: `${op?.label || 'Transfer'} Statistics`,
      icon: op?.icon || 'bar_chart',
      stats,
      operationClass: this.operationClass(),
      operationColor: this.operationColor(),
    };
  });

  transferActivityConfig = computed<TransferActivityPanelConfig>(() => ({
    activeTransfers: this.activeTransfers(),
    completedTransfers: this.completedTransfers(),
    operationClass: this.operationClass(),
    operationColor: this.operationColor(),
    remoteName: this.selectedRemote()?.remoteSpecs?.name || '',
    showHistory: this.completedTransfers().length > 0,
  }));

  // --- Helper Computeds ---
  private operationClass = computed(() =>
    this.isSyncType()
      ? `sync-${this.selectedSyncOperation()}-operation`
      : `${this.mainOperationType()}-operation`
  );

  private operationColor = computed(() => {
    if (!this.isSyncType()) return 'accent';
    const colorMap: Record<string, string> = {
      sync: 'primary',
      copy: 'yellow',
      move: 'orange',
      bisync: 'purple',
    };
    return colorMap[this.selectedSyncOperation()] || 'primary';
  });

  // Cron schedules for all profiles of the current sync operation
  cronSchedules = computed<
    { profileName: string; cronExpression: string; humanReadable: string }[]
  >(() => {
    const settings = this.remoteSettings();
    const opType = this.selectedSyncOperation();
    const configs = settings[`${opType}Configs` as keyof RemoteSettings] as
      | Record<string, { cronEnabled?: boolean; cronExpression?: string | null }>
      | undefined;

    if (!configs) return [];

    const schedules: { profileName: string; cronExpression: string; humanReadable: string }[] = [];

    for (const [profileName, config] of Object.entries(configs)) {
      if (config?.cronEnabled && config?.cronExpression) {
        let humanReadable = 'Invalid schedule';
        try {
          humanReadable = cronstrue(config.cronExpression);
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

  // Filtered control configs by selected profile (works for all operation types)
  filteredOperationControlConfigs = computed(() => {
    const configs = this.operationControlConfigs();
    return this.filterConfigsByProfile(configs);
  });

  filteredMountControlConfigs = computed(() => {
    const configs = this.mountControlConfigs();
    return this.filterConfigsByProfile(configs);
  });

  filteredServeControlConfigs = computed(() => {
    const configs = this.serveControlConfigs();
    return this.filterConfigsByProfile(configs);
  });

  // Helper to filter configs by selected profile
  private filterConfigsByProfile(configs: OperationControlConfig[]): OperationControlConfig[] {
    const selected = this.selectedProfile();

    // If no profile selector or only one config, show all
    if (!this.showProfileSelector() || configs.length <= 1) {
      return configs;
    }

    // Filter by selected profile
    return configs.filter(c => c.profileName === selected);
  }

  // --- Public Methods ---

  onSyncOperationChange(operation: SyncOperationType): void {
    this.selectedSyncOperation.set(operation);
    this.syncOperationChange.emit(operation);
  }

  triggerOpenInFiles(path: string): void {
    const name = this.selectedRemote()?.remoteSpecs?.name;
    if (name) {
      this.openInFiles.emit({ remoteName: name, path });
    }
  }

  onCopyToClipboard(event: { text: string; message: string }): void {
    navigator.clipboard.writeText(event.text).catch(err => {
      console.error('Failed to copy to clipboard:', err);
    });
  }

  onEditSettings(event: { section: string; settings: RemoteSettings }): void {
    const [type, profileName] = event.section.split(':');
    this.openRemoteConfigModal.emit({
      editTarget: type,
      existingConfig: this.remoteSettings(), // Pass FULL config
      targetProfile: profileName, // Optional, undefined if not present
    } as any);
  }

  getSettingsPanelConfig(section: RemoteSettingsSection): SettingsPanelConfig {
    const [key, profileName] = section.key.split(':');
    const settings = this.remoteSettings() as any;

    let specificSettings = {};

    if (profileName) {
      const profiles = settings[`${key}Configs`] as Record<string, any> | undefined;
      if (profiles && typeof profiles === 'object') {
        specificSettings = profiles[profileName] || {};
      }
    } else {
      // Legacy or direct access (vfs, filter, etc)
      specificSettings = settings[`${key}Config`] || {};
    }

    return {
      section,
      settings: specificSettings,
      hasSettings: Object.keys(specificSettings).length > 0,
      restrictMode: this.restrictMode(),
      buttonColor: this.operationColor(),
      buttonLabel: 'Edit Settings',
      sensitiveKeys: SENSITIVE_KEYS,
    };
  }

  shouldShowCharts = computed(() => this.isSyncType());

  // --- Data Fetching Logic (Polling) ---

  private async fetchJobData(jobId: number, remoteName: string): Promise<void> {
    try {
      const group = `job/${jobId}`;

      const [job, remoteStats, completedTransfers] = await Promise.all([
        this.jobService.getJobStatus(jobId),
        this.jobService.getCoreStatsForRemote(remoteName, jobId),
        this.loadCompletedTransfers(group),
      ]);

      if (job) {
        const fullStats = remoteStats ? { ...job, stats: remoteStats } : job;
        this.updateStatsSignals(fullStats);
      }

      if (completedTransfers) {
        this.completedTransfers.set(completedTransfers.slice(0, 50));
      }
    } catch (error) {
      console.error('Error fetching job status:', error);
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

  private updateStatsSignals(job: any): void {
    if (!job.stats) return;

    this.trackCompletedFiles(job);

    const transferring = this.processTransfers(job.stats.transferring);
    this.activeTransfers.set(transferring);

    this.jobStats.set({ ...job.stats, transferring });
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

  private trackCompletedFiles(job: any): void {
    const currentCount = job.stats.transfers || 0;

    if (currentCount > this.lastTransferCount) {
      const activeNames = new Set(job.stats.transferring?.map((f: any) => f.name) || []);
      const currentActive = this.activeTransfers();

      const newCompletions: CompletedTransfer[] = [];

      currentActive.forEach(file => {
        if (!activeNames.has(file.name) && file.percentage > 0 && file.percentage < 100) {
          const completed: CompletedTransfer = {
            ...file,
            checked: false,
            error: '',
            jobid: this.jobId() ?? 0,
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
    this.jobStats.set({ ...DEFAULT_JOB_STATS });
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
