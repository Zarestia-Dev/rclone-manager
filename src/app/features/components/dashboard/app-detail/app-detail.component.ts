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
  CompletedTransfer,
  DEFAULT_JOB_STATS,
  GlobalStats,
  JobInfoConfig,
  OperationControlConfig,
  PathDisplayConfig,
  PrimaryActionType,
  Remote,
  RemoteAction,
  RemoteSettings,
  RemoteSettingsSection,
  SENSITIVE_KEYS,
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
import { IconService } from '../../../../shared/services/icon.service';
import { JobManagementService } from '@app/services';
import { toString as cronstrue } from 'cronstrue';
import { VfsControlPanelComponent } from 'src/app/shared/detail-shared/vfs-control/vfs-control-panel.component';

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
  actionInProgress = input<RemoteAction | null | undefined>(null);

  // --- Outputs ---
  @Output() syncOperationChange = new EventEmitter<SyncOperationType>();
  @Output() openRemoteConfigModal = new EventEmitter<{
    editTarget?: string;
    existingConfig?: RemoteSettings;
  }>();
  @Output() openInFiles = new EventEmitter<{ remoteName: string; path: string }>();
  @Output() startJob = new EventEmitter<{ type: PrimaryActionType; remoteName: string }>();
  @Output() stopJob = new EventEmitter<{ type: PrimaryActionType; remoteName: string }>();

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
        if (id && id !== this.lastJobId) {
          this.lastJobId = id;
          this.resetTransfers();
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
    }
    return !!remote?.mountState?.mounted;
  });

  jobId = computed(() => {
    if (!this.isSyncType()) return undefined;
    const remote = this.selectedRemote();
    const op = this.selectedSyncOperation();

    const stateMap = {
      sync: remote.syncState?.syncJobID,
      bisync: remote.bisyncState?.bisyncJobID,
      move: remote.moveState?.moveJobID,
      copy: remote.copyState?.copyJobID,
    };
    return stateMap[op];
  });

  // --- Config Computeds ---

  operationSettingsSections = computed<RemoteSettingsSection[]>(() => {
    if (this.isSyncType()) {
      const op = this.currentOperation();
      return [
        {
          key: this.selectedSyncOperation(),
          title: `${op?.label || 'Sync'} Options`,
          icon: op?.icon || 'gear',
          group: 'operation',
        },
      ];
    } else {
      return [
        { key: 'mount', title: 'Mount Options', icon: 'gear', group: 'operation' },
        { key: 'vfs', title: 'VFS Options', icon: 'vfs', group: 'operation' },
      ];
    }
  });

  sharedSettingsSections = computed<RemoteSettingsSection[]>(() => [
    { key: 'filter', title: 'Filter Options', icon: 'filter', group: 'shared' },
    { key: 'backend', title: 'Backend Config', icon: 'server', group: 'shared' },
  ]);

  operationSettingsHeading = computed(() => {
    if (this.isSyncType()) {
      const op = this.currentOperation();
      return `${op?.label || 'Sync'} Settings`;
    }
    return this.operationSettingsSections().length > 1 ? 'Mount & VFS Settings' : 'Mount Settings';
  });

  operationSettingsDescription = computed(() => {
    if (this.isSyncType()) {
      const op = this.currentOperation();
      return `Adjust how the ${op?.label?.toLowerCase() || 'sync'} process behaves for this remote.`;
    }
    return 'Configure mount behavior and virtual file system tuning for this remote.';
  });

  // --- Configuration Generators (Computed) ---

  operationControlConfig = computed<OperationControlConfig>(() => {
    const op = this.currentOperation();
    return {
      operationType: this.isSyncType()
        ? (this.selectedSyncOperation() as PrimaryActionType)
        : this.mainOperationType(),
      isActive: this.operationActiveState(),
      isLoading: this.isLoading(),
      cssClass: op?.cssClass || 'primary',
      pathConfig: this.pathConfig(),
      primaryButtonLabel: this.isLoading() ? `Starting ${op?.label}...` : `Start ${op?.label}`,
      secondaryButtonLabel: this.isLoading() ? `Stopping ${op?.label}...` : `Stop ${op?.label}`,
      primaryIcon: op?.icon || 'play_arrow',
      secondaryIcon: 'stop',
      actionInProgress: this.actionInProgress()?.toString(),
      operationDescription: op?.description,
    };
  });

  mountControlConfig = computed<OperationControlConfig>(() => {
    const isActive = !!this.selectedRemote()?.mountState?.mounted;
    const inProgress = this.actionInProgress();
    const isLoading = inProgress === 'mount' || inProgress === 'unmount';

    return {
      operationType: 'mount',
      isActive,
      isLoading,
      cssClass: 'accent',
      pathConfig: this.mountPathConfig(),
      primaryButtonLabel: inProgress === 'mount' ? 'Mounting...' : 'Mount',
      primaryIcon: 'mount',
      secondaryButtonLabel: inProgress === 'unmount' ? 'Unmounting...' : 'Unmount',
      secondaryIcon: 'eject',
      actionInProgress: inProgress?.toString(),
    };
  });

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
    const key = `${this.selectedSyncOperation()}Config`;
    const settings = this.remoteSettings() || {};
    const configObj = (settings as any)[key] || {};

    return {
      source: (configObj['source'] as string) || 'Not configured',
      destination: (configObj['dest'] as string) || 'Not configured',
      showOpenButtons: true,
      isDestinationActive: true,
    };
  });

  private mountPathConfig = computed<PathDisplayConfig>(() => {
    const settings = this.remoteSettings() || {};
    const mountConfig = settings['mountConfig'] || {};

    return {
      source: mountConfig['source'] || 'Not configured',
      destination: mountConfig['dest'] || 'Not configured',
      showOpenButtons: true,
      operationColor: 'accent',
      isDestinationActive: !!this.selectedRemote()?.mountState?.mounted,
      actionInProgress: this.actionInProgress()?.toString(),
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
    this.openRemoteConfigModal.emit({ editTarget: event.section, existingConfig: event.settings });
  }

  getSettingsPanelConfig(section: RemoteSettingsSection): SettingsPanelConfig {
    const settings = (this.remoteSettings() as any)?.[`${section.key}Config`] || {};
    return {
      section,
      settings,
      hasSettings: Object.keys(settings).length > 0,
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
