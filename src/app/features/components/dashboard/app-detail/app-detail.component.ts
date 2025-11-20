import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
  OnInit,
  inject,
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
export class AppDetailComponent implements OnInit, OnChanges, AfterViewInit, OnDestroy {
  // Inputs
  @Input() mainOperationType: PrimaryActionType = 'mount';
  @Input() selectedSyncOperation: SyncOperationType = 'sync';
  @Input() selectedRemote!: Remote;
  @Input() remoteSettings: RemoteSettings = {};
  @Input() restrictMode!: boolean;
  @Input() iconService!: IconService;
  @Input() actionInProgress?: RemoteAction | null;

  // Outputs
  @Output() syncOperationChange = new EventEmitter<SyncOperationType>();
  @Output() openRemoteConfigModal = new EventEmitter<{
    editTarget?: string;
    existingConfig?: RemoteSettings;
  }>();
  @Output() openInFiles = new EventEmitter<{ remoteName: string; path: string }>();
  @Output() startJob = new EventEmitter<{ type: PrimaryActionType; remoteName: string }>();
  @Output() stopJob = new EventEmitter<{ type: PrimaryActionType; remoteName: string }>();

  // View Children
  @ViewChild(MatSort) sort!: MatSort;
  @ViewChild('speedChart') speedChartRef!: ElementRef;
  @ViewChild('progressChart') progressChartRef!: ElementRef;

  // Data
  readonly dataSource = new MatTableDataSource<TransferFile>([]);
  readonly displayedColumns: string[] = ['name', 'percentage', 'speed', 'size', 'eta'];

  jobStats: GlobalStats = { ...DEFAULT_JOB_STATS };
  currentJobId?: number;
  isLoading = false;
  errorMessage = '';

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
  private readonly cdr = inject(ChangeDetectorRef);
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
  }

  // Lifecycle
  ngOnInit(): void {
    this.setupSettingsSections();
  }

  ngAfterViewInit(): void {
    this.dataSource.sort = this.sort;
    this.handleRemoteChange();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (
      changes['mainOperationType'] ||
      changes['selectedSyncOperation'] ||
      changes['selectedRemote']
    ) {
      this.setupSettingsSections();
      this.handleRemoteChange();
      // If we've switched into sync mode, ensure charts are initialized.
      // Use setTimeout to wait for any view updates so @ViewChild refs exist.
      if (this.isSyncType()) {
        setTimeout(() => this.initCharts(), 100);
      } else {
        // If leaving sync mode, destroy charts to free resources.
        this.destroyCharts();
      }
    }
  }

  ngOnDestroy(): void {
    this.stopPolling();
    this.destroyCharts();
  }

  // Public methods
  onSyncOperationChange(operation: SyncOperationType): void {
    if (this.selectedSyncOperation !== operation) {
      this.selectedSyncOperation = operation;
      this.syncOperationChange.emit(operation);
      this.handleRemoteChange();
    }
  }

  triggerOpenInFiles(path: string): void {
    if (this.selectedRemote?.remoteSpecs?.name) {
      this.openInFiles.emit({ remoteName: this.selectedRemote.remoteSpecs.name, path });
    }
  }

  onEditSettings(event: { section: string; settings: RemoteSettings }): void {
    this.openRemoteConfigModal.emit({ editTarget: event.section, existingConfig: event.settings });
  }

  // State checkers
  isSyncType(): boolean {
    return this.mainOperationType === 'sync';
  }

  getOperationActiveState(): boolean {
    if (this.isSyncType()) {
      const remote = this.selectedRemote;
      const states = {
        sync: remote?.syncState?.isOnSync,
        bisync: remote?.bisyncState?.isOnBisync,
        move: remote?.moveState?.isOnMove,
        copy: remote?.copyState?.isOnCopy,
      };
      return !!states[this.selectedSyncOperation];
    }
    return !!this.selectedRemote?.mountState?.mounted;
  }

  shouldShowCharts(): boolean {
    return this.isSyncType();
  }

  // Config getters
  getOperationControlConfig(): OperationControlConfig {
    const op = this.getCurrentOperation();
    return {
      operationType: this.isSyncType()
        ? (this.selectedSyncOperation as PrimaryActionType)
        : this.mainOperationType,
      isActive: this.getOperationActiveState(),
      isLoading: this.isLoading,
      cssClass: op?.cssClass || 'primary',
      pathConfig: this.getPathConfig(),
      primaryButtonLabel: this.isLoading ? `Starting ${op?.label}...` : `Start ${op?.label}`,
      secondaryButtonLabel: this.isLoading ? `Stopping ${op?.label}...` : `Stop ${op?.label}`,
      primaryIcon: op?.icon || 'play_arrow',
      secondaryIcon: 'stop',
      actionInProgress: this.actionInProgress?.toString(),
      operationDescription: op?.description,
    };
  }

  getMountControlConfig(): OperationControlConfig {
    const isActive = !!this.selectedRemote?.mountState?.mounted;
    const isLoading = ['mount', 'unmount'].includes(this.actionInProgress as string);

    return {
      operationType: 'mount',
      isActive,
      isLoading,
      cssClass: 'accent',
      pathConfig: this.getMountPathConfig(),
      primaryButtonLabel: this.actionInProgress === 'mount' ? 'Mounting...' : 'Mount',
      primaryIcon: 'mount',
      secondaryButtonLabel: this.actionInProgress === 'unmount' ? 'Unmounting...' : 'Unmount',
      secondaryIcon: 'eject',
      actionInProgress: this.actionInProgress?.toString(),
    };
  }

  getJobInfoConfig(): JobInfoConfig {
    return {
      operationType: this.isSyncType()
        ? this.selectedSyncOperation
        : (this.mainOperationType ?? 'mount'),
      jobId: this.currentJobId,
      startTime: this.jobStats.startTime ? new Date(this.jobStats.startTime) : undefined,
    };
  }

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

  getSettingsPanelConfig(section: RemoteSettingsSection): SettingsPanelConfig {
    const settings = this.remoteSettings?.[`${section.key}Config`] || {};
    return {
      section,
      settings,
      hasSettings: Object.keys(settings).length > 0,
      restrictMode: this.restrictMode,
      buttonColor: this.getOperationColor(),
      buttonLabel: 'Edit Settings',
      sensitiveKeys: SENSITIVE_KEYS,
    };
  }

  getTransferActivityConfig(): TransferActivityPanelConfig {
    return {
      activeTransfers: this.activeTransfers,
      completedTransfers: this.completedTransfers,
      operationClass: this.getOperationClass(),
      operationColor: this.getOperationColor(),
      remoteName: this.selectedRemote?.remoteSpecs?.name || '',
      showHistory: this.completedTransfers.length > 0,
    };
  }

  get operationSettingsHeading(): string {
    if (this.isSyncType()) {
      const op = this.getCurrentOperation();
      return `${op?.label || 'Sync'} Settings`;
    }
    return this.operationSettingsSections.length > 1 ? 'Mount & VFS Settings' : 'Mount Settings';
  }

  get operationSettingsDescription(): string {
    if (this.isSyncType()) {
      const op = this.getCurrentOperation();
      return `Adjust how the ${op?.label?.toLowerCase() || 'sync'} process behaves for this remote.`;
    }
    return 'Configure mount behavior and virtual file system tuning for this remote.';
  }

  // Private helpers
  private getCurrentOperation(): SyncOperation | null {
    return this.syncOperations.find(op => op.type === this.selectedSyncOperation) || null;
  }

  private setupSettingsSections(): void {
    if (this.isSyncType()) {
      const op = this.getCurrentOperation();
      this.operationSettingsSections = [
        {
          key: this.selectedSyncOperation,
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
  }

  private getPathConfig(): PathDisplayConfig {
    const configKey = `${this.selectedSyncOperation}Config`;
    return {
      source: (this.remoteSettings?.[configKey]?.['source'] as string) || 'Not configured',
      destination: (this.remoteSettings?.[configKey]?.['dest'] as string) || 'Not configured',
      showOpenButtons: true,
      isDestinationActive: true,
    };
  }

  private getMountPathConfig(): PathDisplayConfig {
    return {
      source: this.remoteSettings?.['mountConfig']?.['source'] || 'Not configured',
      destination: this.remoteSettings?.['mountConfig']?.['dest'] || 'Not configured',
      showOpenButtons: true,
      operationColor: 'accent',
      isDestinationActive: !!this.selectedRemote?.mountState?.mounted,
      actionInProgress: this.actionInProgress?.toString(),
    };
  }

  private getOperationClass(): string {
    return this.isSyncType()
      ? `sync-${this.selectedSyncOperation}-operation`
      : `${this.mainOperationType}-operation`;
  }

  private getOperationColor(): string {
    if (!this.isSyncType()) return 'accent';
    const colorMap = { sync: 'primary', copy: 'accent', move: 'warn', bisync: 'primary' };
    return colorMap[this.selectedSyncOperation] || 'primary';
  }

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

    this.cdr.markForCheck();
  }

  private getJobId(): number | undefined {
    if (!this.isSyncType() || !this.selectedRemote) return undefined;

    const stateMap = {
      sync: this.selectedRemote.syncState?.syncJobID,
      bisync: this.selectedRemote.bisyncState?.bisyncJobID,
      move: this.selectedRemote.moveState?.moveJobID,
      copy: this.selectedRemote.copyState?.copyJobID,
    };

    return stateMap[this.selectedSyncOperation];
  }

  // Polling
  private startPolling(): void {
    this.stopPolling();

    this.ngZone.runOutsideAngular(() => {
      this.pollingInterval = window.setInterval(() => {
        if (!this.getOperationActiveState() || !this.currentJobId) {
          this.stopPolling();
          this.fetchJobData().then(() => this.ngZone.run(() => this.cdr.markForCheck()));
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
    if (!this.currentJobId || !this.selectedRemote?.remoteSpecs?.name) return;

    try {
      const remoteName = this.selectedRemote.remoteSpecs.name;
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
        this.cdr.detectChanges();
      });
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

  private updateStats(job: any): void {
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

  private processTransfers(files: any[] = []): TransferFile[] {
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

  private trackCompletedFiles(job: any): void {
    const currentCount = job.stats.transfers || 0;

    if (currentCount > this.lastTransferCount) {
      const activeNames = new Set(job.stats.transferring?.map((f: any) => f.name) || []);

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

    const yScale = this.speedChart.options.scales?.['y'] as any;
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
    const config = this.remoteSettings?.[`${this.selectedSyncOperation}Config`];
    return !!config?.['cronEnabled'];
  }

  getHumanReadableCron(): string {
    const config = this.remoteSettings?.[`${this.selectedSyncOperation}Config`];
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
