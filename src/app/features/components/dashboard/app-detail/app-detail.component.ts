import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
  input,
  output,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Chart, registerables } from 'chart.js';
import { MatDividerModule } from '@angular/material/divider';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatButtonModule } from '@angular/material/button';
import { MatTabsModule } from '@angular/material/tabs';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTableDataSource } from '@angular/material/table';
import { MatSort, MatSortModule } from '@angular/material/sort';
import { FormatTimePipe } from 'src/app/shared/pipes/format-time.pipe';
import { FormatFileSizePipe } from 'src/app/shared/pipes/format-file-size.pipe';
import {
  CompletedTransfer,
  DEFAULT_JOB_STATS,
  GlobalStats,
  JobInfo,
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
import { VfsControlPanelComponent } from 'src/app/shared/components/vfs/vfs-control-panel.component';

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
    MatSortModule,
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
export class AppDetailComponent implements AfterViewInit, OnDestroy {
  // Inputs
  mainOperationType = input<PrimaryActionType>('mount');
  selectedSyncOperation = input<SyncOperationType>('sync');
  selectedRemote = input.required<Remote>();
  remoteSettings = input<RemoteSettings>({});
  restrictMode = input.required<boolean>();
  iconService = input.required<IconService>();
  actionInProgress = input<RemoteAction | null>(null);

  // Outputs
  syncOperationChange = output<SyncOperationType>();
  openRemoteConfigModal = output<{
    editTarget?: string;
    existingConfig?: RemoteSettings;
  }>();
  openInFiles = output<{ remoteName: string; path: string }>();
  startJob = output<{ type: PrimaryActionType; remoteName: string }>();
  stopJob = output<{ type: PrimaryActionType; remoteName: string }>();

  // View Children
  @ViewChild(MatSort) sort!: MatSort;
  @ViewChild('speedChart') speedChartRef!: ElementRef;
  @ViewChild('progressChart') progressChartRef!: ElementRef;

  // Data
  readonly dataSource = new MatTableDataSource<TransferFile>([]);
  readonly displayedColumns: string[] = ['name', 'percentage', 'speed', 'size', 'eta'];

  jobStats: GlobalStats = { ...DEFAULT_JOB_STATS };
  currentJobId?: number;

  // Transfers tracking
  activeTransfers: TransferFile[] = [];
  completedTransfers: CompletedTransfer[] = [];
  private lastTransferCount = 0;

  // Charts
  private speedChart?: Chart;
  private progressChart?: Chart;
  private speedHistory: number[] = [];
  private progressHistory: number[] = [];
  private readonly MAX_HISTORY = 30;

  // Settings sections
  operationSettingsSections: RemoteSettingsSection[] = [];
  sharedSettingsSections: RemoteSettingsSection[] = [];
  readonly sharedSettingsHeading = 'Shared Settings';
  readonly sharedSettingsDescription =
    'Applies to all operations, regardless of sync or mount mode.';

  // Polling
  private pollingInterval?: number;
  private readonly POLL_INTERVAL_MS = 1000;

  // Services
  private readonly ngZone = inject(NgZone);
  private readonly jobService = inject(JobManagementService);
  private readonly formatFileSize = new FormatFileSizePipe();
  private readonly formatTime = new FormatTimePipe();

  // Sync operations config
  readonly syncOperations: SyncOperation[] = [
    {
      type: 'sync',
      label: 'Sync',
      icon: 'refresh',
      cssClass: 'primary',
      description: 'One-way synchronization - makes destination match source',
    },
    {
      type: 'bisync',
      label: 'BiSync',
      icon: 'right-left',
      cssClass: 'purple',
      description: 'Bidirectional sync - keeps both locations synchronized',
    },
    {
      type: 'move',
      label: 'Move',
      icon: 'move',
      cssClass: 'orange',
      description: 'Move files - transfer from source to destination (deletes from source)',
    },
    {
      type: 'copy',
      label: 'Copy',
      icon: 'copy',
      cssClass: 'yellow',
      description: 'Copy files - duplicate from source to destination (preserves source)',
    },
  ];

  constructor() {
    Chart.register(...registerables);

    // Effect for initialization
    effect(() => {
      this.setupSettingsSections();
    });

    // Effect for remote changes
    effect(() => {
      this.selectedRemote();
      this.mainOperationType();
      this.selectedSyncOperation();
      // Trigger setup when these change
      this.setupSettingsSections();
      this.handleRemoteChange();
      // If we've switched into sync mode, ensure charts are initialized.
      if (this.isSyncType()) {
        setTimeout(() => this.initCharts(), 100);
      } else {
        this.destroyCharts();
      }
    });
  }

  ngAfterViewInit(): void {
    this.dataSource.sort = this.sort;
  }

  ngOnDestroy(): void {
    this.stopPolling();
    this.destroyCharts();
  }

  // Public methods
  onSyncOperationChange(operation: SyncOperationType): void {
    this.syncOperationChange.emit(operation);
  }

  triggerOpenInFiles(path: string): void {
    const remoteName = this.selectedRemote().remoteSpecs?.name;
    if (remoteName) {
      this.openInFiles.emit({ remoteName, path });
    }
  }

  onEditSettings(event: { section: string; settings: RemoteSettings }): void {
    this.openRemoteConfigModal.emit({ editTarget: event.section, existingConfig: event.settings });
  }

  // State checkers
  isSyncType = computed(() => this.mainOperationType() === 'sync');

  getOperationActiveState = computed(() => {
    const isSync = this.isSyncType();
    const remote = this.selectedRemote();
    const selectedOp = this.selectedSyncOperation();
    if (isSync) {
      const states = {
        sync: remote?.syncState?.isOnSync,
        bisync: remote?.bisyncState?.isOnBisync,
        move: remote?.moveState?.isOnMove,
        copy: remote?.copyState?.isOnCopy,
      };
      return !!states[selectedOp];
    }
    return !!remote?.mountState?.mounted;
  });

  shouldShowCharts = computed(() => this.isSyncType());

  // Config getters
  getOperationControlConfig = computed(() => {
    const op = this.getCurrentOperation();
    const isSync = this.isSyncType();
    const selectedOp = this.selectedSyncOperation();
    const mainOp = this.mainOperationType();
    const isLoading = this.actionInProgress() === selectedOp;
    return {
      operationType: isSync ? (selectedOp as PrimaryActionType) : mainOp,
      isActive: this.getOperationActiveState(),
      isLoading: isLoading,
      cssClass: op?.cssClass || 'primary',
      pathConfig: this.getPathConfig(),
      primaryButtonLabel: isLoading ? `Starting ${op?.label}...` : `Start ${op?.label}`,
      secondaryButtonLabel: isLoading ? `Stopping ${op?.label}...` : `Stop ${op?.label}`,
      primaryIcon: op?.icon || 'play_arrow',
      secondaryIcon: 'stop',
      actionInProgress: this.actionInProgress()?.toString(),
      operationDescription: op?.description,
    };
  });

  getMountControlConfig = computed(() => {
    const remote = this.selectedRemote();
    const action = this.actionInProgress();
    const isActive = !!remote?.mountState?.mounted;
    const isLoading = ['mount', 'unmount'].includes(action as string);

    return {
      operationType: 'mount' as PrimaryActionType,
      isActive,
      isLoading,
      cssClass: 'accent',
      pathConfig: this.getMountPathConfig(),
      primaryButtonLabel: action === 'mount' ? 'Mounting...' : 'Mount',
      primaryIcon: 'mount',
      secondaryButtonLabel: action === 'unmount' ? 'Unmounting...' : 'Unmount',
      secondaryIcon: 'eject',
      actionInProgress: action?.toString(),
    };
  });

  getJobInfoConfig = computed(() => {
    const isSync = this.isSyncType();
    const selectedOp = this.selectedSyncOperation();
    const mainOp = this.mainOperationType();
    return {
      operationType: isSync ? selectedOp : (mainOp ?? 'mount'),
      jobId: this.currentJobId,
      startTime: this.jobStats.startTime ? new Date(this.jobStats.startTime) : undefined,
    };
  });

  getStatsConfig(): StatsPanelConfig {
    const progress = this.calculateProgress();
    const stats: StatItem[] = [
      {
        value: this.formatProgress(),
        label: 'Progress',
        isPrimary: true,
        progress,
      },
      {
        value: this.formatSpeed(this.jobStats.speed || 0),
        label: 'Speed',
      },
      {
        value: this.formatTime.transform(this.jobStats.eta),
        label: 'ETA',
        isPrimary: true,
        progress: this.calculateEtaProgress(),
      },
      {
        value: `${this.jobStats.transfers || 0}/${this.jobStats.totalTransfers || 0}`,
        label: 'Files',
      },
      {
        value: this.jobStats.errors || 0,
        label: 'Errors',
        hasError: (this.jobStats.errors || 0) > 0,
        tooltip: this.jobStats.lastError,
      },
      {
        value: this.formatTime.transform(this.jobStats.elapsedTime),
        label: 'Duration',
      },
    ];

    const op = this.getCurrentOperation();
    return {
      title: `${op?.label || 'Transfer'} Statistics`,
      icon: op?.icon || 'bar_chart',
      stats,
      operationClass: this.getOperationClass(),
      operationColor: this.getOperationColor(),
    };
  }

  getSettingsPanelConfig = (section: RemoteSettingsSection): SettingsPanelConfig => {
    const settings = this.remoteSettings()[`${section.key}Config`] || {};
    return {
      section,
      settings,
      hasSettings: Object.keys(settings).length > 0,
      restrictMode: this.restrictMode(),
      buttonColor: this.getOperationColor(),
      buttonLabel: 'Edit Settings',
      sensitiveKeys: SENSITIVE_KEYS,
    };
  };

  getTransferActivityConfig = computed(() => {
    return {
      activeTransfers: this.activeTransfers,
      completedTransfers: this.completedTransfers,
      operationClass: this.getOperationClass(),
      operationColor: this.getOperationColor(),
      remoteName: this.selectedRemote().remoteSpecs?.name || '',
      showHistory: this.completedTransfers.length > 0,
    };
  });

  operationSettingsHeading = computed(() => {
    const isSync = this.isSyncType();
    if (isSync) {
      const op = this.getCurrentOperation();
      return `${op?.label || 'Sync'} Settings`;
    }
    return this.operationSettingsSections.length > 1 ? 'Mount & VFS Settings' : 'Mount Settings';
  });

  operationSettingsDescription = computed(() => {
    const isSync = this.isSyncType();
    if (isSync) {
      const op = this.getCurrentOperation();
      return `Adjust how the ${op?.label?.toLowerCase() || 'sync'} process behaves for this remote.`;
    }
    return 'Configure mount behavior and virtual file system tuning for this remote.';
  });

  // Private helpers
  private getCurrentOperation = (): SyncOperation | null => {
    return this.syncOperations.find(op => op.type === this.selectedSyncOperation()) || null;
  };

  private setupSettingsSections = (): void => {
    if (this.isSyncType()) {
      const op = this.getCurrentOperation();
      this.operationSettingsSections = [
        {
          key: this.selectedSyncOperation(),
          title: `${op?.label || 'Sync'} Options`,
          icon: op?.icon || 'gear',
          group: 'operation',
        },
      ];
    } else {
      this.operationSettingsSections = [
        { key: 'mount', title: 'Mount Options', icon: 'gear', group: 'operation' },
        { key: 'vfs', title: 'VFS Options', icon: 'vfs', group: 'operation' },
      ];
    }

    this.sharedSettingsSections = [
      { key: 'filter', title: 'Filter Options', icon: 'filter', group: 'shared' },
      { key: 'backend', title: 'Backend Config', icon: 'server', group: 'shared' },
    ];
  };

  private getPathConfig = (): PathDisplayConfig => {
    const configKey = `${this.selectedSyncOperation()}Config`;
    const settings = this.remoteSettings();
    return {
      source: (settings[configKey]?.['source'] as string) || 'Not configured',
      destination: (settings[configKey]?.['dest'] as string) || 'Not configured',
      showOpenButtons: true,
      isDestinationActive: true,
    };
  };

  private getMountPathConfig = (): PathDisplayConfig => {
    const settings = this.remoteSettings();
    return {
      source: settings?.['mountConfig']?.['source'] || 'Not configured',
      destination: settings?.['mountConfig']?.['dest'] || 'Not configured',
      showOpenButtons: true,
      operationColor: 'accent',
      isDestinationActive: !!this.selectedRemote()?.mountState?.mounted,
      actionInProgress: this.actionInProgress()?.toString(),
    };
  };

  private getOperationClass = (): string => {
    return this.isSyncType()
      ? `sync-${this.selectedSyncOperation()}-operation`
      : `${this.mainOperationType()}-operation`;
  };

  private getOperationColor = (): string => {
    if (!this.isSyncType()) return 'accent';
    const colorMap = { sync: 'primary', copy: 'accent', move: 'warn', bisync: 'primary' };
    return colorMap[this.selectedSyncOperation()] || 'primary';
  };

  // Stats formatting
  private formatProgress(): string {
    const { bytes, totalBytes } = this.jobStats;
    if (totalBytes > 0) {
      return `${this.formatFileSize.transform(bytes)} / ${this.formatFileSize.transform(totalBytes)}`;
    }
    return this.formatFileSize.transform(bytes);
  }

  formatSpeed(speed: number): string {
    return `${this.formatFileSize.transform(speed)}/s`;
  }

  calculateProgress(): number {
    const { bytes, totalBytes } = this.jobStats;
    return totalBytes > 0 ? Math.min(100, (bytes / totalBytes) * 100) : 0;
  }

  private calculateEtaProgress(): number {
    const { elapsedTime, eta } = this.jobStats;
    return elapsedTime && eta ? (elapsedTime / (elapsedTime + eta)) * 100 : 0;
  }

  // Remote change handler
  private handleRemoteChange(): void {
    const newJobId = this.getJobId();

    if (this.currentJobId !== newJobId && newJobId) {
      this.resetTransfers();
    }

    this.currentJobId = newJobId;

    if (this.getOperationActiveState()) {
      this.startPolling();
    } else {
      this.stopPolling();
      this.activeTransfers = [];
    }
  }

  private getJobId(): number | undefined {
    if (!this.isSyncType() || !this.selectedRemote) return undefined;

    const remote = this.selectedRemote();
    const stateMap = {
      sync: remote.syncState?.syncJobID,
      bisync: remote.bisyncState?.bisyncJobID,
      move: remote.moveState?.moveJobID,
      copy: remote.copyState?.copyJobID,
    };

    return stateMap[this.selectedSyncOperation()];
  }

  // Polling
  private startPolling(): void {
    this.stopPolling();

    this.ngZone.runOutsideAngular(() => {
      this.pollingInterval = window.setInterval(() => {
        if (!this.getOperationActiveState() || !this.currentJobId) {
          this.stopPolling();
          this.fetchJobData();
          return;
        }
        this.fetchJobData();
      }, this.POLL_INTERVAL_MS);
    });
  }

  private stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
    }
  }

  private async fetchJobData(): Promise<void> {
    const selectedRemote = this.selectedRemote();
    if (!this.currentJobId || !selectedRemote?.remoteSpecs?.name) return;

    try {
      const remoteName = selectedRemote.remoteSpecs.name;
      const group = `job/${this.currentJobId}`;

      const [job, remoteStats, completedTransfers] = await Promise.all([
        this.jobService.getJobStatus(this.currentJobId),
        this.jobService.getCoreStatsForRemote(remoteName, this.currentJobId),
        this.loadCompletedTransfers(group),
      ]);

      this.ngZone.run(() => {
        if (job) {
          this.updateStats(remoteStats ? { ...job, stats: remoteStats } : job);
        }
        if (completedTransfers) {
          this.completedTransfers = completedTransfers.slice(0, 50);
        }
      });
    } catch (error) {
      console.error('Error fetching job status:', error);
    }
  }

  private async loadCompletedTransfers(group: string): Promise<CompletedTransfer[] | null> {
    try {
      const response: unknown = await this.jobService.getCompletedTransfers(group);
      let transfers: unknown[] = [];

      if (Array.isArray(response)) {
        transfers = response;
      } else if (response && typeof response === 'object' && 'transferred' in response) {
        const transferred = (response as { transferred?: unknown }).transferred;
        if (Array.isArray(transferred)) {
          transfers = transferred;
        }
      }

      if (!Array.isArray(transfers)) return null;

      return transfers.map((t: unknown) => this.mapTransfer(t as Record<string, unknown>));
    } catch {
      return null;
    }
  }

  private mapTransfer(transfer: Record<string, unknown>): CompletedTransfer {
    let status: 'completed' | 'checked' | 'failed' | 'partial' = 'completed';

    if (transfer['error']) status = 'failed';
    else if (transfer['checked']) status = 'checked';
    else if (
      (transfer['bytes'] as number) > 0 &&
      (transfer['bytes'] as number) < (transfer['size'] as number)
    )
      status = 'partial';

    return {
      name: (transfer['name'] as string) || '',
      size: (transfer['size'] as number) || 0,
      bytes: (transfer['bytes'] as number) || 0,
      checked: (transfer['checked'] as boolean) || false,
      error: (transfer['error'] as string) || '',
      jobid: transfer['group'] ? parseInt((transfer['group'] as string).replace('job/', '')) : 0,
      startedAt: transfer['started_at'] as string,
      completedAt: transfer['completed_at'] as string,
      srcFs: transfer['srcFs'] as string,
      dstFs: transfer['dstFs'] as string,
      group: transfer['group'] as string,
      status,
    };
  }

  private updateStats(job: JobInfo): void {
    if (!job.stats) return;

    this.trackCompletedFiles(job);
    this.jobStats = { ...job.stats, transferring: this.processTransfers(job.stats.transferring) };
    this.activeTransfers = this.processTransfers(job.stats.transferring);
    this.updateCharts();
    this.dataSource.data = [
      ...this.activeTransfers,
      ...this.completedTransfers.map(this.toTransferFile),
    ];
  }

  private processTransfers(files: TransferFile[] = []): TransferFile[] {
    return files.map(f => ({
      ...f,
      percentage: f.size > 0 ? Math.min(100, Math.round((f.bytes / f.size) * 100)) : 0,
      isError: f.bytes < f.size && f.percentage === 100,
      isCompleted: false,
    }));
  }

  private toTransferFile(t: CompletedTransfer): TransferFile {
    return {
      name: t.name,
      bytes: t.bytes,
      size: t.size,
      dstFs: t.dstFs ?? '',
      srcFs: t.srcFs ?? '',
      group: t.group ?? '',
      eta: 0,
      percentage: 100,
      speed: 0,
      speedAvg: 0,
      isError: t.status === 'failed',
      isCompleted: true,
    };
  }

  private trackCompletedFiles(job: JobInfo): void {
    const currentCount = job.stats.transfers || 0;

    if (currentCount > this.lastTransferCount) {
      const activeNames = new Set(job.stats.transferring?.map((f: TransferFile) => f.name) || []);

      this.activeTransfers.forEach(file => {
        if (!activeNames.has(file.name) && file.percentage > 0 && file.percentage < 100) {
          const completed: CompletedTransfer = {
            ...file,
            checked: false,
            error: '',
            jobid: this.currentJobId ?? 0,
            status: 'completed',
            startedAt: undefined,
            completedAt: new Date().toISOString(),
            srcFs: undefined,
            dstFs: undefined,
            group: undefined,
          };

          if (!this.completedTransfers.some(cf => cf.name === file.name)) {
            this.completedTransfers.unshift(completed);
          }
        }
      });

      this.lastTransferCount = currentCount;
    }
  }

  private resetTransfers(): void {
    this.activeTransfers = [];
    this.completedTransfers = [];
    this.lastTransferCount = 0;
    this.speedHistory = [];
    this.progressHistory = [];
  }

  // Charts
  private initCharts(): void {
    this.destroyCharts();
    if (this.speedChartRef?.nativeElement && this.progressChartRef?.nativeElement) {
      this.speedChart = this.createChart(this.speedChartRef.nativeElement, 'Speed', '#4285F4');
      this.progressChart = this.createChart(
        this.progressChartRef.nativeElement,
        'Progress (%)',
        '#34A853',
        100
      );
    }
  }

  private createChart(
    canvas: HTMLCanvasElement,
    yTitle: string,
    color: string,
    max?: number
  ): Chart {
    return new Chart(canvas, {
      type: 'line',
      data: {
        labels: Array(this.MAX_HISTORY).fill(''),
        datasets: [
          {
            label: yTitle,
            data: Array(this.MAX_HISTORY).fill(0),
            borderColor: color,
            backgroundColor: `${color}20`,
            tension: 0.4,
            fill: true,
            pointRadius: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        plugins: { legend: { display: false } },
        scales: {
          x: { display: false },
          y: { beginAtZero: true, max, title: { display: true, text: yTitle } },
        },
      },
    });
  }

  private updateCharts(): void {
    if (!this.speedChart || !this.progressChart) return;

    this.updateChart(this.progressChart, this.progressHistory, this.calculateProgress());

    const { value, unit } = this.getSpeedUnit(this.jobStats.speed || 0);
    this.updateChart(this.speedChart, this.speedHistory, value);

    const yScale = this.speedChart.options.scales?.['y'] as { title?: { text?: string } };
    if (yScale?.title) yScale.title.text = `Speed (${unit})`;
  }

  private updateChart(chart: Chart, history: number[], newValue: number): void {
    const lastValue = history[history.length - 1] || 0;

    if (Math.abs(newValue - lastValue) > 0.5) {
      history.push(newValue);
      if (history.length > this.MAX_HISTORY) history.shift();
      chart.data.datasets[0].data = [...history];
      chart.update('none');
    }
  }

  private getSpeedUnit(bps: number): { value: number; unit: string } {
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let speed = bps;
    let i = 0;

    while (speed >= 1024 && i < units.length - 1) {
      speed /= 1024;
      i++;
    }

    return { value: Math.round(speed * 100) / 100, unit: units[i] };
  }

  private destroyCharts(): void {
    this.speedChart?.destroy();
    this.progressChart?.destroy();
    this.speedChart = undefined;
    this.progressChart = undefined;
  }

  isCronEnabled(): boolean {
    const config =
      this.remoteSettings()?.[(this.selectedSyncOperation() + 'Config') as keyof RemoteSettings];
    return !!config?.['cronEnabled'];
  }

  getHumanReadableCron(): string {
    const config =
      this.remoteSettings()?.[(this.selectedSyncOperation() + 'Config') as keyof RemoteSettings];
    const cronExpression = config?.['cronExpression'] as string;
    if (!cronExpression) {
      return 'No schedule set.';
    }
    try {
      return cronstrue(cronExpression);
    } catch {
      return 'Invalid cron expression.';
    }
  }
}
