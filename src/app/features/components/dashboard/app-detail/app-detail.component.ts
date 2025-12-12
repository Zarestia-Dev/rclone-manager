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
    if (!this.isSyncType()) return [];

    const type = this.selectedSyncOperation();
    const settings = this.remoteSettings();
    const configProfiles = (settings as any)[`${type}Configs`] || [];

    if (Array.isArray(configProfiles) && configProfiles.length > 0) {
      return configProfiles.map((p: any) => ({ name: p.name, label: p.name }));
    }

    // No profiles exist, return default
    return [{ name: 'default', label: 'Default' }];
  });

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
  // --- Computed Signals ---

  remoteName = computed(() => this.selectedRemote().remoteSpecs.name);

  isSyncType = computed(() => this.mainOperationType() === 'sync');

  currentOperation = computed(
    () => this.syncOperations.find(op => op.type === this.selectedSyncOperation()) || null
  );

  operationActiveState = computed(() => {
    const remote = this.selectedRemote();
    if (this.isSyncType()) {
      const op = this.selectedSyncOperation();
      const states = {
        sync: remote?.syncState?.isOnSync,
        bisync: remote?.bisyncState?.isOnBisync,
        move: remote?.moveState?.isOnMove,
        copy: remote?.copyState?.isOnCopy,
      };
      return !!states[op];
    } else if (this.mainOperationType() === 'serve') {
      // Check if any serves exist for this remote
      const serves = this.runningServes();
      return serves.some(s => s.params.fs.startsWith(remote.remoteSpecs.name + ':'));
    }
    return !!remote?.mountState?.mounted;
  });

  jobId = computed(() => {
    if (!this.isSyncType()) return undefined;
    const remote = this.selectedRemote();
    const op = this.selectedSyncOperation();
    const profile = this.selectedProfile();

    const stateMap: any = {
      sync: remote.syncState,
      bisync: remote.bisyncState,
      move: remote.moveState,
      copy: remote.copyState,
    };

    const state = stateMap[op];

    // If a specific profile is selected (and it's not the placeholder 'default')
    if (profile && profile !== 'default') {
      return state?.activeProfiles?.[profile]; // Returns undefined if not found, preventing wrong job stats
    }

    // Fallback to main job ID (legacy or default) only if no specific profile selected
    const legacyKeyMap: any = {
      sync: 'syncJobID',
      bisync: 'bisyncJobID',
      move: 'moveJobID',
      copy: 'copyJobID',
    };
    return state?.[legacyKeyMap[op]];
  });

  operationSettingsSections = computed<RemoteSettingsSection[]>(() => {
    const sections: RemoteSettingsSection[] = [];
    const settings = this.remoteSettings();

    if (this.isSyncType()) {
      const type = this.selectedSyncOperation();
      const op = this.currentOperation();
      // Get profiles array (e.g., 'copyConfigs') or fallback to legacy single config if array missing
      const profiles = (settings as any)[`${type}Configs`];

      if (Array.isArray(profiles) && profiles.length > 0) {
        profiles.forEach((p: any) => {
          sections.push({
            key: `${type}:${p.name}`, // Composite key
            title: `${op?.label || 'Sync'} Options (${p.name})`,
            icon: op?.icon || 'gear',
            group: 'operation',
          } as any);
        });
      } else {
        // Always show at least one default section even if no profiles exist
        sections.push({
          key: type,
          title: `${op?.label || 'Sync'} Options`,
          icon: op?.icon || 'gear',
          group: 'operation',
        } as any);
      }
      // VFS is now handled in sharedSettingsSections with profiles
    } else if (this.mainOperationType() === 'serve') {
      const type = 'serve';
      const profiles = (settings as any)[`${type}Configs`];

      if (Array.isArray(profiles) && profiles.length > 0) {
        profiles.forEach((p: any) => {
          sections.push({
            key: `${type}:${p.name}`,
            title: `Protocol Options (${p.name})`,
            icon: 'satellite-dish',
            group: 'operation',
          } as any);
        });
      } else {
        // Always show at least one default section even if no profiles exist
        sections.push({
          key: type,
          title: 'Protocol Options',
          icon: 'satellite-dish',
          group: 'operation',
        } as any);
      }
    } else {
      // Mount profiles
      const type = 'mount';
      const profiles = (settings as any)[`${type}Configs`];

      if (Array.isArray(profiles) && profiles.length > 0) {
        profiles.forEach((p: any) => {
          sections.push({
            key: `${type}:${p.name}`,
            title: `Mount Options (${p.name})`,
            icon: 'gear',
            group: 'operation',
          } as any);
        });
      } else {
        // Always show at least one default section even if no profiles exist
        sections.push({
          key: type,
          title: 'Mount Options',
          icon: 'gear',
          group: 'operation',
        } as any);
      }

      // VFS is now handled in sharedSettingsSections with profiles
    }
    return sections;
  });

  sharedSettingsSections = computed<RemoteSettingsSection[]>(() => {
    const sections: RemoteSettingsSection[] = [];
    const settings = this.remoteSettings() || {};
    const operationType = this.mainOperationType();

    // Helper to add sections for a type
    const addSections = (type: string, titlePrefix: string, icon: string) => {
      const profiles = (settings as any)[`${type}Configs`];
      if (Array.isArray(profiles) && profiles.length > 0) {
        profiles.forEach((p: any) => {
          sections.push({
            key: `${type}:${p.name}`,
            title: `${titlePrefix} (${p.name})`,
            icon: icon,
            group: 'shared',
          } as any);
        });
      } else {
        sections.push({
          key: type,
          title: titlePrefix,
          icon: icon,
          group: 'shared',
        });
      }
    };

    // VFS is only relevant for mount and serve operations (not for sync/copy/move/bisync)
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
    const settings = this.remoteSettings() || {};
    const profiles = (settings as any)[`${type}Configs`];

    // If we have multiple profiles, create a config for each
    if (Array.isArray(profiles) && profiles.length > 0) {
      return profiles.map((profile: any) =>
        this.createOperationControlConfig(
          type,
          op,
          this.getPathConfigForProfile(profile),
          profile.name
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
    const settings = this.remoteSettings() || {};
    const profiles = (settings as any)['mountConfigs'];

    if (Array.isArray(profiles) && profiles.length > 0) {
      return profiles.map((p: any) => this.createMountControlConfig(p, p.name));
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
    const settings = this.remoteSettings() || {};
    const profiles = (settings as any)['serveConfigs'];

    if (Array.isArray(profiles) && profiles.length > 0) {
      return profiles.map((p: any) => this.createServeControlConfig(p, p.name));
    }

    // Always show at least one default config
    return [this.createServeControlConfig({}, undefined)];
  });

  private createServeControlConfig(config: any, profileName?: string): OperationControlConfig {
    const serves = this.runningServes();
    const remote = this.selectedRemote();

    let isActive = false;
    // Check if ANY serve matches this profile?
    // Serve params include profile name if passed.
    // But ServeListItem params structure might need inspection.
    // Current backend ServeParams includes `profile` field.
    // Let's assume ServeListItem.params has it.

    if (profileName) {
      isActive = serves.some(
        s =>
          s.params.fs.startsWith(remote.remoteSpecs.name + ':') &&
          (s.params as any).profile === profileName
      );
    } else {
      // Legacy check: any serve for this remote without profile? Or just any serve?
      isActive = serves.some(s => s.params.fs.startsWith(remote.remoteSpecs.name + ':'));
    }

    const inProgressActions = this.actionInProgress();
    const actionMatch = inProgressActions?.find(
      a => a.type === 'serve' && (a.profileName === profileName || (!a.profileName && !profileName))
    );

    return {
      operationType: 'serve',
      isActive,
      isLoading: !!actionMatch,
      cssClass: 'primary', // Or distinct color?
      pathConfig: {
        source: 'Serving ' + remote.remoteSpecs.name, // Abstract source representation
        destination: (config?.options?.addr as string) || 'Default Address',
        showOpenButtons: false,
        operationColor: 'primary',
        isDestinationActive: isActive,
      },
      primaryButtonLabel: isActive ? 'Serving' : 'Start Serve', // Status indicator? Or just Start?
      // Typically Start / Stop.
      // If Active -> Show Stop? No, OperationControl usually handles toggle style differently?
      // Wait, OperationControl has primary/secondary buttons.
      // If isActive is true, secondary button (Stop) is usually shown if configured.
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

  private pathConfig = computed<PathDisplayConfig>(() => {
    const opType = this.selectedSyncOperation();
    const settings = this.remoteSettings() || {};

    const profiles = (settings as any)[`${opType}Configs`];
    let configObj: any = {};

    if (Array.isArray(profiles) && profiles.length > 0) {
      configObj = profiles.find((p: any) => p.name === 'default') || {};
    }

    return {
      source: (configObj['source'] as string) || 'Not configured',
      destination: (configObj['dest'] as string) || 'Not configured',
      showOpenButtons: true,
      isDestinationActive: true,
    };
  });

  private operationClass = computed(() =>
    this.isSyncType()
      ? `sync-${this.selectedSyncOperation()}-operation`
      : `${this.mainOperationType()}-operation`
  );

  private operationColor = computed(() => {
    if (!this.isSyncType()) return 'accent';
    const colorMap: Record<string, string> = {
      sync: 'primary',
      copy: 'accent',
      move: 'warn',
      bisync: 'primary',
    };
    return colorMap[this.selectedSyncOperation()] || 'primary';
  });

  isCronEnabled = computed(() => {
    const settings = this.remoteSettings();
    const config = (settings as any)?.[`${this.selectedSyncOperation()}Config`];
    return !!config?.['cronEnabled'];
  });

  humanReadableCron = computed(() => {
    const settings = this.remoteSettings();
    const config = (settings as any)?.[`${this.selectedSyncOperation()}Config`];
    const cronExpression = config?.['cronExpression'] as string;

    if (!cronExpression) return 'No schedule set.';
    try {
      return cronstrue(cronExpression);
    } catch {
      return 'Invalid cron expression.';
    }
  });

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
      const profiles = settings[`${key}Configs`];
      if (Array.isArray(profiles)) {
        specificSettings = profiles.find((p: any) => p.name === profileName) || {};
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
