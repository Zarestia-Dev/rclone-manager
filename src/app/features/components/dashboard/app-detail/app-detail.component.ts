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
import { Subscription } from 'rxjs';
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

// Interfaces for better type safety
interface OperationState {
  isActive: boolean;
  jobId?: number;
  lastOperationTime?: Date;
  errorState?: string;
}

interface ChartData {
  speedHistory: number[];
  progressHistory: number[];
  chart?: Chart;
}

interface TransferTracker {
  activeTransfers: TransferFile[];
  completedTransfers: CompletedTransfer[];
  lastTransferCount: number;
}

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
  ],
  templateUrl: './app-detail.component.html',
  styleUrls: ['./app-detail.component.scss'],
})
export class AppDetailComponent implements OnInit, OnChanges, AfterViewInit, OnDestroy {
  @Input() mainOperationType: PrimaryActionType = 'mount';
  @Input() selectedSyncOperation: SyncOperationType = 'sync';
  @Input() selectedRemote!: Remote;
  @Input() remoteSettings: RemoteSettings = {};
  @Input() restrictMode!: boolean;
  @Input() iconService!: IconService;
  @Input() actionInProgress?: RemoteAction | null;

  @Output() syncOperationChange = new EventEmitter<SyncOperationType>();
  @Output() openRemoteConfigModal = new EventEmitter<{
    editTarget?: string;
    existingConfig?: RemoteSettings;
  }>();
  @Output() openInFiles = new EventEmitter<{
    remoteName: string;
    path: string;
  }>();
  @Output() startJob = new EventEmitter<{ type: PrimaryActionType; remoteName: string }>();
  @Output() stopJob = new EventEmitter<{ type: PrimaryActionType; remoteName: string }>();

  @ViewChild(MatSort) sort!: MatSort;
  @ViewChild('speedChart') speedChartRef!: ElementRef;
  @ViewChild('progressChart') progressChartRef!: ElementRef;

  // Core data properties
  readonly dataSource = new MatTableDataSource<TransferFile>([]);
  readonly displayedColumns: string[] = ['name', 'percentage', 'speed', 'size', 'eta'];

  // State management
  private readonly operationStates = new Map<SyncOperationType, OperationState>();
  private readonly transferTracker: TransferTracker = {
    activeTransfers: [],
    completedTransfers: [],
    lastTransferCount: 0,
  };

  FormatTimePipe = new FormatTimePipe();

  // Charts management
  private readonly chartData: Record<'speed' | 'progress', ChartData> = {
    speed: { speedHistory: [], progressHistory: [] },
    progress: { speedHistory: [], progressHistory: [] },
  };

  // Job and stats
  jobStats: GlobalStats = { ...DEFAULT_JOB_STATS };
  currentJobId?: number;
  isLoading = false;
  errorMessage = '';
  remoteSettingsSections: RemoteSettingsSection[] = [];

  // Configuration and constants
  private readonly MAX_HISTORY_LENGTH = 30;
  private readonly POLLING_INTERVAL = 1000;
  private readonly CHART_UPDATE_THRESHOLD = 0.5;

  // Utilities
  private readonly formatFileSize = new FormatFileSizePipe();
  private readonly formatTime = new FormatTimePipe();

  // Subscriptions
  private dataInterval?: number;
  private jobSubscription?: Subscription;

  // Dependency injection
  private readonly ngZone = inject(NgZone);
  private readonly jobManagementService = inject(JobManagementService);
  private readonly cdr = inject(ChangeDetectorRef);

  // Enhanced sync operations configuration
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
    this.initializeOperationStates();
  }

  // Lifecycle hooks
  ngOnInit(): void {
    this.setupRemoteSettingsSections();
  }

  ngAfterViewInit(): void {
    this.dataSource.sort = this.sort;
    this.handleSelectedRemoteChange();
    if (this.shouldShowCharts()) {
      setTimeout(() => this.initChartsIfNeeded(), 0);
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (this.hasRelevantChanges(changes)) {
      this.handleOperationChange();
    }
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  // Public API methods
  onSyncOperationChange(operation: SyncOperationType): void {
    if (this.selectedSyncOperation !== operation) {
      this.selectedSyncOperation = operation;
      this.syncOperationChange.emit(operation);
      this.handleOperationChange();
    }
  }

  onMainTabChange(event: { index: number }): void {
    if (event.index === 0 && this.shouldShowCharts()) {
      setTimeout(() => this.initChartsIfNeeded(), 0);
    }
  }

  triggerOpenInFiles(path: string): void {
    const remoteName = this.selectedRemote?.remoteSpecs?.name;
    if (remoteName) {
      this.openInFiles.emit({ remoteName, path });
    }
  }

  triggerOpenRemoteConfig(editTarget?: string, existingConfig?: RemoteSettings): void {
    this.openRemoteConfigModal.emit({ editTarget, existingConfig });
  }

  onEditSettings(event: { section: string; settings: RemoteSettings }): void {
    this.triggerOpenRemoteConfig(event.section, event.settings);
  }

  // Configuration getters
  getOperationControlConfig(): OperationControlConfig {
    const currentOp = this.getCurrentOperationConfig();
    const operationType = this.isSyncType()
      ? (this.selectedSyncOperation as PrimaryActionType)
      : this.mainOperationType;

    return {
      operationType,
      isActive: this.getOperationActiveState(),
      isLoading: this.isLoading,
      cssClass:
        this.syncOperations.find(op => op.type === this.selectedSyncOperation)?.cssClass ||
        'primary',
      pathConfig: this.getPathDisplayConfig(),
      primaryButtonLabel: this.getPrimaryButtonLabel(),
      secondaryButtonLabel: this.getSecondaryButtonLabel(),
      primaryIcon: currentOp?.icon || 'play_arrow',
      secondaryIcon: 'stop',
      actionInProgress: this.actionInProgress?.toString(),
      operationDescription: currentOp?.description,
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
      pathConfig: this.getMountPathDisplayConfig(),
      primaryButtonLabel: this.actionInProgress === 'mount' ? 'Mounting...' : 'Mount',
      primaryIcon: 'mount',
      secondaryButtonLabel: this.actionInProgress === 'unmount' ? 'Unmounting...' : 'Unmount',
      secondaryIcon: 'eject',
      actionInProgress: this.actionInProgress?.toString(),
    };
  }

  getJobInfoConfig(): JobInfoConfig {
    const operationType = this.isSyncType()
      ? this.selectedSyncOperation
      : (this.mainOperationType ?? 'mount');

    return {
      operationType,
      jobId: this.currentJobId,
      startTime: this.jobStats.startTime ? new Date(this.jobStats.startTime) : undefined,
      lastOperationTime: this.getLastOperationTime(),
    };
  }

  getStatsConfig(): StatsPanelConfig {
    const stats: StatItem[] = [
      {
        value: this.formatProgressValue(),
        label: 'Progress',
        isPrimary: true,
        progress: this.calculateProgress(),
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
        tooltip: this.jobStats.lastError ? `Last Error: ${this.jobStats.lastError}` : undefined,
      },
      {
        value: this.formatTime.transform(this.jobStats.elapsedTime),
        label: 'Duration',
      },
    ];

    return {
      title: this.getStatsTitle(),
      icon: this.getCurrentOperationConfig()?.icon || 'bar_chart',
      stats,
      operationClass: this.getOperationClass(),
      operationColor: this.getOperationColor(),
    };
  }

  getSettingsPanelConfig(section: RemoteSettingsSection): SettingsPanelConfig {
    const configKey = `${section.key}Config`;
    const settings = this.getRemoteSettings(configKey);

    return {
      section,
      settings,
      hasSettings: this.hasSettings(configKey),
      restrictMode: this.restrictMode,
      buttonColor: this.getOperationColor(),
      buttonLabel: 'Edit Settings',
      sensitiveKeys: SENSITIVE_KEYS,
    };
  }

  getTransferActivityConfig(): TransferActivityPanelConfig {
    return {
      activeTransfers: this.transferTracker.activeTransfers,
      completedTransfers: this.transferTracker.completedTransfers,
      operationClass: this.getOperationClass(),
      operationColor: this.getOperationColor(),
      remoteName: this.selectedRemote?.remoteSpecs?.name || '',
      showHistory: this.transferTracker.completedTransfers.length > 0,
    };
  }

  // State checking methods
  isSyncType(): boolean {
    return this.mainOperationType === 'sync';
  }

  isMountType(): boolean {
    return this.mainOperationType === 'mount';
  }

  shouldShowCharts(): boolean {
    return this.isSyncType();
  }

  getOperationActiveState(): boolean {
    if (this.isSyncType()) {
      return this.getSyncOperationState(this.selectedSyncOperation);
    }
    return !!this.selectedRemote?.mountState?.mounted;
  }

  // Private helper methods
  private initializeOperationStates(): void {
    (['sync', 'copy', 'move', 'bisync'] as SyncOperationType[]).forEach(type => {
      this.operationStates.set(type, {
        isActive: false,
        jobId: undefined,
        lastOperationTime: undefined,
      });
    });
  }

  private hasRelevantChanges(changes: SimpleChanges): boolean {
    return !!(
      changes['mainOperationType'] ||
      changes['selectedSyncOperation'] ||
      changes['selectedRemote']
    );
  }

  private handleOperationChange(): void {
    this.setupRemoteSettingsSections();
    this.handleSelectedRemoteChange();

    if (this.shouldShowCharts()) {
      setTimeout(() => this.initChartsIfNeeded(), 0);
    } else {
      this.destroyCharts();
    }
  }

  private setupRemoteSettingsSections(): void {
    // Always show backend config section
    const backendSection = {
      key: 'backend',
      title: 'Backend Config',
      icon: 'server',
    };
    if (this.isSyncType()) {
      const currentOp = this.getCurrentOperationConfig();
      this.remoteSettingsSections = [
        {
          key: this.selectedSyncOperation,
          title: `${currentOp?.label} Options`,
          icon: 'gear',
        },
        {
          key: 'filter',
          title: 'Filter Options',
          icon: 'filter',
        },
        backendSection,
      ];
    } else {
      this.remoteSettingsSections = [
        {
          key: 'mount',
          title: 'Mount Options',
          icon: 'gear',
        },
        {
          key: 'vfs',
          title: 'VFS Options',
          icon: 'vfs',
        },
        backendSection,
      ];
    }
  }

  getCurrentOperationConfig(): SyncOperation | null {
    if (!this.isSyncType()) return null;
    return this.syncOperations.find(op => op.type === this.selectedSyncOperation) || null;
  }

  private getSyncOperationState(operation: SyncOperationType): boolean {
    const remote = this.selectedRemote;
    if (!remote) return false;

    switch (operation) {
      case 'sync':
        return !!remote.syncState?.isOnSync;
      case 'bisync':
        return !!remote.bisyncState?.isOnBisync;
      case 'move':
        return !!remote.moveState?.isOnMove;
      case 'copy':
        return !!remote.copyState?.isOnCopy;
      default:
        return false;
    }
  }

  private getCurrentJobId(): number | undefined {
    if (!this.isSyncType() || !this.selectedRemote) return undefined;

    const remote = this.selectedRemote;
    switch (this.selectedSyncOperation) {
      case 'sync':
        return remote.syncState?.syncJobID;
      case 'bisync':
        return remote.bisyncState?.bisyncJobID;
      case 'move':
        return remote.moveState?.moveJobID;
      case 'copy':
        return remote.copyState?.copyJobID;
      default:
        return undefined;
    }
  }

  getOperationClass(): string {
    if (this.isSyncType()) {
      return `sync-${this.selectedSyncOperation}-operation`;
    }
    return `${this.mainOperationType}-operation`;
  }

  private getOperationColor(): string {
    if (this.isSyncType()) {
      const operation = this.getCurrentOperationConfig();
      switch (operation?.type) {
        case 'sync':
          return 'primary';
        case 'copy':
          return 'accent';
        case 'move':
          return 'warn';
        case 'bisync':
          return 'primary';
        default:
          return 'primary';
      }
    }
    return 'accent';
  }

  private getPrimaryButtonLabel(): string {
    const currentOp = this.getCurrentOperationConfig();
    const label = currentOp?.label || this.mainOperationType;

    if (this.isLoading) {
      return `Starting ${label}...`;
    }

    return `Start ${label}`;
  }

  private getSecondaryButtonLabel(): string {
    const currentOp = this.getCurrentOperationConfig();
    const label = currentOp?.label || this.mainOperationType;

    if (this.isLoading) {
      return `Stopping ${label}...`;
    }

    return `Stop ${label}`;
  }

  private getStatsTitle(): string {
    const currentOp = this.getCurrentOperationConfig();
    return `${currentOp?.label || 'Transfer'} Statistics`;
  }

  private getLastOperationTime(): string | undefined {
    const operationState = this.operationStates.get(this.selectedSyncOperation);
    return operationState?.lastOperationTime?.toLocaleString();
  }

  private getPathDisplayConfig(): PathDisplayConfig {
    return {
      source: this.getOperationSource(),
      destination: this.getOperationDestination(),
      showOpenButtons: true,
      isDestinationActive: true,
    };
  }

  private getMountPathDisplayConfig(): PathDisplayConfig {
    return {
      source: this.getMountSource(),
      destination: this.getMountDestination(),
      showOpenButtons: true,
      operationColor: 'accent',
      isDestinationActive: !!this.selectedRemote?.mountState?.mounted,
      actionInProgress: this.actionInProgress?.toString(),
    };
  }

  getOperationSource(): string {
    const configKey = `${this.selectedSyncOperation}Config`;
    return (this.remoteSettings?.[configKey]?.['source'] as string) || 'Not configured';
  }

  getOperationDestination(): string {
    const configKey = `${this.selectedSyncOperation}Config`;
    return (this.remoteSettings?.[configKey]?.['dest'] as string) || 'Not configured';
  }

  getMountSource(): string {
    return this.remoteSettings?.['mountConfig']?.['source'] || 'Not configured';
  }

  getMountDestination(): string {
    return this.remoteSettings?.['mountConfig']?.['dest'] || 'Not configured';
  }

  // Statistics and formatting methods
  private formatProgressValue(): string {
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
    if (elapsedTime && eta) {
      return (elapsedTime / (elapsedTime + eta)) * 100;
    }
    return 0;
  }

  // Chart management
  private initChartsIfNeeded(): void {
    this.destroyCharts();
    if (this.speedChartRef?.nativeElement && this.progressChartRef?.nativeElement) {
      this.initCharts();
    }
  }

  private initCharts(): void {
    this.chartData.speed.chart = this.createChart(
      this.speedChartRef.nativeElement,
      'Transfer Speed',
      '#4285F4',
      'Speed'
    );

    this.chartData.progress.chart = this.createChart(
      this.progressChartRef.nativeElement,
      'Overall Progress',
      '#34A853',
      'Progress (%)',
      100
    );
  }

  private createChart(
    element: HTMLCanvasElement,
    label: string,
    color: string,
    yAxisTitle: string,
    max?: number
  ): Chart {
    return new Chart(element, {
      type: 'line',
      data: {
        labels: Array(this.MAX_HISTORY_LENGTH).fill(''),
        datasets: [
          {
            label,
            data: Array(this.MAX_HISTORY_LENGTH).fill(0),
            borderColor: color,
            backgroundColor: `${color}20`,
            tension: 0.4,
            fill: true,
            pointRadius: 2,
            pointHoverRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        interaction: {
          intersect: false,
          mode: 'index',
        },
        plugins: {
          legend: {
            display: false,
          },
        },
        scales: {
          x: {
            display: false,
            grid: { display: false },
          },
          y: {
            beginAtZero: true,
            max,
            title: {
              display: true,
              text: yAxisTitle,
              font: { size: 12 },
            },
            grid: {
              color: 'rgba(0,0,0,0.1)',
            },
          },
        },
      },
    });
  }

  private updateChartData(): void {
    if (!this.chartData.speed.chart || !this.chartData.progress.chart) return;

    const progress = this.calculateProgress();
    const speedData = this.getSpeedUnitAndValue(this.jobStats.speed || 0);

    // Update progress chart
    this.updateChart(this.chartData.progress, progress, this.chartData.progress.chart, 'progress');

    // Update speed chart
    this.updateChart(
      this.chartData.speed,
      speedData.value,
      this.chartData.speed.chart,
      'speed',
      speedData.unit
    );
  }

  private updateChart(
    chartData: ChartData,
    newValue: number,
    chart: Chart,
    type: 'progress' | 'speed',
    unit?: string
  ): void {
    const history = type === 'progress' ? chartData.progressHistory : chartData.speedHistory;
    const lastValue = history[history.length - 1] || 0;

    if (Math.abs(newValue - lastValue) > this.CHART_UPDATE_THRESHOLD) {
      history.push(newValue);
      if (history.length > this.MAX_HISTORY_LENGTH) {
        history.shift();
      }

      chart.data.datasets[0].data = [...history];

      if (unit && type === 'speed') {
        const yScale = chart.options.scales?.['y'] as { title?: { text: string } };
        if (yScale?.title) {
          yScale.title.text = `Speed (${unit})`;
        }
      }

      chart.update('none');
    }
  }

  private getSpeedUnitAndValue(speedInBps: number): { value: number; unit: string } {
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];
    let speed = speedInBps;
    let unitIndex = 0;

    while (speed >= 1024 && unitIndex < units.length - 1) {
      speed /= 1024;
      unitIndex++;
    }

    return { value: Math.round(speed * 100) / 100, unit: units[unitIndex] };
  }

  private destroyCharts(): void {
    Object.values(this.chartData).forEach(data => {
      data.chart?.destroy();
      data.chart = undefined;
    });
  }

  // Data management and polling
  private handleSelectedRemoteChange(): void {
    this.resetTransferTracker();
    this.currentJobId = this.getCurrentJobId();

    if (this.getOperationActiveState()) {
      this.startDataPolling();
      this.updateLastOperationTime();
    } else {
      this.stopDataPolling();
    }

    this.cdr.markForCheck();
  }

  private startDataPolling(): void {
    this.stopDataPolling();

    this.ngZone.runOutsideAngular(() => {
      this.dataInterval = window.setInterval(() => {
        if (!this.getOperationActiveState() || !this.currentJobId) {
          this.stopDataPolling();
          return;
        }

        this.fetchJobStatus();
      }, this.POLLING_INTERVAL);
    });
  }

  private stopDataPolling(): void {
    if (this.dataInterval) {
      clearInterval(this.dataInterval);
      this.dataInterval = undefined;
    }
  }

  private async fetchJobStatus(): Promise<void> {
    if (!this.currentJobId || !this.selectedRemote?.remoteSpecs?.name) {
      return;
    }

    try {
      const remoteName = this.selectedRemote.remoteSpecs.name;
      const group = `job/${this.currentJobId}`;

      const [job, remoteStats, completedTransfers] = await Promise.all([
        this.jobManagementService.getJobStatus(this.currentJobId),
        this.jobManagementService.getCoreStatsForRemote(remoteName, this.currentJobId),
        this.loadCompletedTransfers(group),
      ]);

      this.ngZone.run(() => {
        if (job) {
          const statsToUse = remoteStats ? { ...job, stats: remoteStats } : job;
          this.updateStatsFromJob(statsToUse);
        }

        if (completedTransfers) {
          this.updateCompletedTransfers(completedTransfers);
        }

        this.cdr.detectChanges();
      });
    } catch (error) {
      console.error('Error fetching job status:', error);
    }
  }

  private async loadCompletedTransfers(group: string): Promise<CompletedTransfer[] | null> {
    try {
      const response: any = await this.jobManagementService.getCompletedTransfers(group);

      if (response?.transferred && Array.isArray(response.transferred)) {
        return response.transferred.map((transfer: any) => this.mapTransferFromApi(transfer));
      }

      if (Array.isArray(response)) {
        return response.map((transfer: any) => this.mapTransferFromApi(transfer));
      }

      return null;
    } catch (error) {
      console.warn('Could not load completed transfers:', error);
      return null;
    }
  }

  private mapTransferFromApi(transfer: any): CompletedTransfer {
    let status: 'completed' | 'checked' | 'failed' | 'partial' = 'completed';

    if (transfer.error && transfer.error !== '') {
      status = 'failed';
    } else if (transfer.checked === true) {
      status = 'checked';
    } else if (transfer.bytes > 0 && transfer.bytes < transfer.size) {
      status = 'partial';
    }

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

  private updateStatsFromJob(job: any): void {
    if (!job.stats) return;

    // Track completed transfers
    this.trackCompletedTransfers(job);

    // Update job stats
    this.jobStats = {
      ...job.stats,
      transferring: this.processTransferringFiles(job.stats.transferring),
    };

    // Update UI components
    this.updateTransferDisplays(job.stats);
    this.updateRemoteStatusOnError(job);
    this.updateChartData();
    this.cdr.markForCheck();
  }

  private trackCompletedTransfers(job: any): void {
    const currentTransferCount = job.stats.transfers || 0;

    if (currentTransferCount > this.transferTracker.lastTransferCount) {
      const currentTransferring = job.stats.transferring || [];
      const activeNames = new Set(currentTransferring.map((f: any) => f.name));

      // Find files that completed since last update
      const previousActive = this.transferTracker.activeTransfers;
      previousActive.forEach(file => {
        if (!activeNames.has(file.name) && file.percentage > 0 && file.percentage < 100) {
          const completedFile: CompletedTransfer = {
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

          // Add to completed transfers if not already present
          if (!this.transferTracker.completedTransfers.some(cf => cf.name === file.name)) {
            this.transferTracker.completedTransfers.unshift(completedFile);

            // Keep only recent completed transfers
            if (this.transferTracker.completedTransfers.length > 50) {
              this.transferTracker.completedTransfers =
                this.transferTracker.completedTransfers.slice(0, 50);
            }
          }
        }
      });

      this.transferTracker.lastTransferCount = currentTransferCount;
    }
  }

  private updateTransferDisplays(stats: any): void {
    // Update active transfers
    this.transferTracker.activeTransfers = this.processTransferringFiles(stats.transferring);

    // Update data source for backward compatibility
    const allTransfers: TransferFile[] = [
      ...this.transferTracker.activeTransfers,
      ...this.transferTracker.completedTransfers.map(transfer => ({
        ...transfer,
        eta: 0,
        percentage: 100,
        speed: 0,
        speedAvg: 0,
        isError: transfer.status === 'failed',
        isCompleted: true,
        dstFs: transfer.dstFs ?? '',
        srcFs: transfer.srcFs ?? '',
        group: transfer.group ?? '',
        startedAt: transfer.startedAt ?? '',
        completedAt: transfer.completedAt ?? '',
      })),
    ];
    this.dataSource.data = allTransfers;
  }

  private processTransferringFiles(files: any[] = []): TransferFile[] {
    return files.map(file => ({
      ...file,
      percentage: file.size > 0 ? Math.min(100, Math.round((file.bytes / file.size) * 100)) : 0,
      isError: file.bytes < file.size && file.percentage === 100,
      isCompleted: false,
    }));
  }

  private updateCompletedTransfers(transfers: CompletedTransfer[]): void {
    const transfersJson = JSON.stringify(transfers);
    const currentJson = JSON.stringify(this.transferTracker.completedTransfers);

    if (transfersJson !== currentJson) {
      this.transferTracker.completedTransfers = transfers
        .sort((a, b) => {
          const aTime = a.completedAt ? new Date(a.completedAt).getTime() : 0;
          const bTime = b.completedAt ? new Date(b.completedAt).getTime() : 0;
          return bTime - aTime;
        })
        .slice(0, 50); // Keep only 50 most recent
    }
  }

  private updateRemoteStatusOnError(job: any): void {
    if (job.stats.fatalError && this.selectedRemote) {
      const stateKey = this.getStateKeyForOperation();

      if (stateKey) {
        this.selectedRemote = {
          ...this.selectedRemote,
          [stateKey]: {
            ...(this.selectedRemote as any)[stateKey],
            isOnSync: 'error', // This should be updated based on operation type
          },
        };
      }
    }
  }

  private getStateKeyForOperation(): string | null {
    switch (this.selectedSyncOperation) {
      case 'sync':
        return 'syncState';
      case 'copy':
        return 'copyState';
      case 'move':
        return 'moveState';
      case 'bisync':
        return 'bisyncState';
      default:
        return null;
    }
  }

  private updateLastOperationTime(): void {
    const operationState = this.operationStates.get(this.selectedSyncOperation);
    if (operationState) {
      operationState.lastOperationTime = new Date();
    }
  }

  private resetTransferTracker(): void {
    this.transferTracker.activeTransfers = [];
    this.transferTracker.completedTransfers = [];
    this.transferTracker.lastTransferCount = 0;

    // Reset chart histories
    Object.values(this.chartData).forEach(data => {
      data.progressHistory = [];
      data.speedHistory = [];
    });
  }

  // Settings and utility methods
  getRemoteSettings(sectionKey: string): RemoteSettings {
    return this.remoteSettings?.[sectionKey] || {};
  }

  hasSettings(sectionKey: string): boolean {
    return Object.keys(this.getRemoteSettings(sectionKey)).length > 0;
  }

  isSensitiveKey(key: string): boolean {
    return (
      SENSITIVE_KEYS.some(sensitive => key.toLowerCase().includes(sensitive.toLowerCase())) &&
      this.restrictMode
    );
  }

  maskSensitiveValue(key: string, value: string): string {
    return this.isSensitiveKey(key) ? '••••••••' : this.truncateValue(value, 50);
  }

  isLocalPath(path: string): boolean {
    if (!path) return false;
    return (
      /^[a-zA-Z]:[\\/]/.test(path) || // Windows path
      path.startsWith('/') || // Unix absolute path
      path.startsWith('~/') || // Home directory
      path.startsWith('./') // Relative path
    );
  }

  isObjectButNotArray(value: unknown): boolean {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  // Getter properties for template compatibility
  get transferSummary(): { total: number; completed: number; active: number } {
    return {
      total: this.jobStats.totalTransfers || 0,
      completed: (this.jobStats.totalTransfers || 0) - (this.jobStats.transfers || 0),
      active: this.transferTracker.activeTransfers.length,
    };
  }

  get errorSummary(): string {
    if (this.jobStats.fatalError) {
      return this.jobStats.lastError || 'Fatal error occurred';
    }
    if ((this.jobStats.errors || 0) > 0) {
      return `${this.jobStats.errors} error(s) occurred`;
    }
    return '';
  }

  get operationDestination(): string {
    const configKey = `${this.selectedSyncOperation}Config`;
    return (this.remoteSettings?.[configKey]?.['dest'] as string) || 'Not configured';
  }

  get operationSource(): string {
    const configKey = `${this.selectedSyncOperation}Config`;
    return (this.remoteSettings?.[configKey]?.['source'] as string) || 'Not configured';
  }

  get operationColor(): string {
    return this.getOperationColor();
  }

  get operationClass(): string {
    return this.getOperationClass();
  }

  get mountDestination(): string {
    return this.getMountDestination();
  }

  get mountSource(): string {
    return this.getMountSource();
  }

  // Utility methods
  private truncateValue(value: any, length: number): string {
    if (value == null) return '';

    if (typeof value === 'object') {
      try {
        const jsonString = JSON.stringify(value, null, 2);
        return jsonString.length > length ? `${jsonString.slice(0, length)}...` : jsonString;
      } catch {
        return '[Invalid JSON]';
      }
    }

    const stringValue = String(value);
    return stringValue.length > length ? `${stringValue.slice(0, length)}...` : stringValue;
  }

  // Cleanup methods
  private cleanup(): void {
    this.stopDataPolling();
    this.destroyCharts();
    this.jobSubscription?.unsubscribe();
    this.resetTransferTracker();
  }
}
