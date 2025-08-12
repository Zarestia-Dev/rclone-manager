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
import { ThemePalette } from '@angular/material/core';
import { FormatTimePipe } from 'src/app/shared/pipes/format-time.pipe';
import { FormatFileSizePipe } from 'src/app/shared/pipes/format-file-size.pipe';
import {
  DEFAULT_JOB_STATS,
  GlobalStats,
  Remote,
  RemoteAction,
  RemoteSettings,
  RemoteSettingsSection,
  SENSITIVE_KEYS,
  TransferFile,
} from '../../../../shared/components/types';
import {
  CompletedTransfer,
  JobInfoConfig,
  JobInfoPanelComponent,
  MainOperationType,
  OperationControlComponent,
  OperationControlConfig,
  PathDisplayConfig,
  SettingsPanelComponent,
  SettingsPanelConfig,
  StatItem,
  StatsPanelComponent,
  StatsPanelConfig,
  SyncOperationType,
  TransferActivityPanelComponent,
  TransferActivityPanelConfig,
} from '../../../../shared/detail-shared';

import { IconService } from '../../../../shared/services/icon.service';
import { JobManagementService } from '@app/services';

interface SyncOperation {
  type: SyncOperationType;
  label: string;
  icon: string;
  color: ThemePalette;
  description: string;
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
  @Input() mainOperationType: MainOperationType = 'mount';
  @Input() selectedSyncOperation: SyncOperationType = 'sync';
  @Input() selectedRemote: Remote | null = null;
  @Input() remoteSettings: RemoteSettings = {};
  @Input() restrictMode!: boolean;
  @Input() iconService!: IconService;
  @Input() actionInProgress?: RemoteAction | null;

  // Operation specific outputs
  @Output() primaryAction = new EventEmitter<{
    mainType: MainOperationType;
    subType?: SyncOperationType;
    remoteName: string;
  }>();
  @Output() secondaryAction = new EventEmitter<{
    mainType: MainOperationType;
    subType?: SyncOperationType;
    remoteName: string;
  }>();
  @Output() syncOperationChange = new EventEmitter<SyncOperationType>();

  // Common outputs
  @Output() openRemoteConfigModal = new EventEmitter<{
    editTarget?: string;
    existingConfig?: RemoteSettings;
  }>();
  @Output() openInFiles = new EventEmitter<{
    remoteName: string;
    path: string;
  }>();
  // @Output() extendedData = new EventEmitter<{
  //   resync: boolean;
  // }>();

  @ViewChild(MatSort) sort!: MatSort;
  @ViewChild('speedChart') speedChartRef!: ElementRef;
  @ViewChild('progressChart') progressChartRef!: ElementRef;

  // Operation specific properties
  dataSource = new MatTableDataSource<TransferFile>([]);
  displayedColumns: string[] = ['name', 'percentage', 'speed', 'size', 'eta'];
  jobStats: GlobalStats = { ...DEFAULT_JOB_STATS };
  currentJobId?: number;
  isLoading = false;
  errorMessage = '';
  FormatFileSizePipe = new FormatFileSizePipe();
  FormatTimePipe = new FormatTimePipe();
  private lastSyncDate?: Date;

  // Track completed transfers to show in the panel
  private completedTransfers: TransferFile[] = [];
  private activeTransfers: TransferFile[] = [];
  private lastTransferCount = 0;

  // Enhanced transfer tracking
  private recentCompletedTransfers: CompletedTransfer[] = [];
  private showTransferHistory = false;

  private speedChart!: Chart;
  private progressChart!: Chart;
  private dataInterval?: number;
  private speedHistory: number[] = [];
  private progressHistory: number[] = [];
  private jobSubscription?: Subscription;

  remoteSettingsSections: RemoteSettingsSection[] = [];
  readonly MAX_HISTORY_LENGTH = 30;
  readonly POLLING_INTERVAL = 1000;

  private ngZone = inject(NgZone);
  private jobManagementService = inject(JobManagementService);
  private cdr = inject(ChangeDetectorRef);

  constructor() {
    Chart.register(...registerables);
  }

  syncOperations: SyncOperation[] = [
    {
      type: 'sync',
      label: 'Sync',
      icon: 'refresh',
      color: 'primary',
      description: 'One-way synchronization - makes destination match source',
    },
    {
      type: 'bisync',
      label: 'BiSync',
      icon: 'right-left',
      color: 'accent',
      description: 'Bidirectional sync - keeps both locations synchronized',
    },
    {
      type: 'move',
      label: 'Move',
      icon: 'move',
      color: 'warn',
      description: 'Move files - transfer from source to destination (deletes from source)',
    },
    {
      type: 'copy',
      label: 'Copy',
      icon: 'copy',
      color: 'primary',
      description: 'Copy files - duplicate from source to destination (preserves source)',
    },
  ];

  // handleExtendedData($event: { resync: boolean }): void {
  //   this.extendedData.emit($event);
  // }

  isSyncType(): boolean {
    return this.mainOperationType === 'sync';
  }

  isMountType(): boolean {
    return this.mainOperationType === 'mount';
  }

  hasCharts(): boolean {
    return this.isSyncType();
  }

  // Get current operation configuration
  getCurrentOperationConfig(): SyncOperation | null {
    if (!this.isSyncType()) return null;
    return this.syncOperations.find(op => op.type === this.selectedSyncOperation) || null;
  }

  // Handle sync operation change
  onSyncOperationChange(operation: SyncOperationType): void {
    this.selectedSyncOperation = operation;
    this.syncOperationChange.emit(operation);
    this.handleOperationChange();
  }

  // Primary action handler - updated for new structure
  handlePrimaryAction(): void {
    console.log(
      'Primary action triggered for:',
      this.mainOperationType,
      this.selectedSyncOperation
    );

    if (this.selectedRemote?.remoteSpecs?.name) {
      this.primaryAction.emit({
        mainType: this.mainOperationType,
        subType: this.isSyncType() ? this.selectedSyncOperation : undefined,
        remoteName: this.selectedRemote.remoteSpecs.name,
      });
    }
  }

  // Secondary action handler - updated for new structure
  handleSecondaryAction(): void {
    if (this.selectedRemote?.remoteSpecs?.name) {
      this.secondaryAction.emit({
        mainType: this.mainOperationType,
        subType: this.isSyncType() ? this.selectedSyncOperation : undefined,
        remoteName: this.selectedRemote.remoteSpecs.name,
      });
    }
  }

  // Updated configuration builders
  getOperationControlConfig(): OperationControlConfig {
    const currentOp = this.getCurrentOperationConfig();

    return {
      operationType: this.mainOperationType,
      subOperationType: this.isSyncType() ? this.selectedSyncOperation : undefined,
      isActive: this.getOperationActiveState(),
      isError: this.getOperationErrorState(),
      isLoading: this.isLoading,
      operationColor: currentOp?.color || 'primary',
      operationClass: this.getOperationClass(),
      pathConfig: this.getPathDisplayConfig(),
      primaryButtonLabel: `Start ${currentOp?.label || this.mainOperationType}`,
      secondaryButtonLabel: `Stop ${currentOp?.label || this.mainOperationType}`,
      primaryIcon: currentOp?.icon || 'play',
      secondaryIcon: 'stop',
      actionInProgress: this.actionInProgress?.toString(),
      operationDescription: currentOp?.description,
    };
  }

  getMountControlConfig(): OperationControlConfig {
    const isActive = !!(
      this.selectedRemote?.mountState?.mounted &&
      this.selectedRemote?.mountState?.mounted !== 'error'
    );

    return {
      operationType: 'mount',
      isActive,
      isError: this.selectedRemote?.mountState?.mounted === 'error',
      isLoading: this.actionInProgress === 'mount' || this.actionInProgress === 'unmount',
      operationColor: 'accent',
      operationClass: 'mount-operation',
      pathConfig: this.getMountPathDisplayConfig(),
      primaryButtonLabel: this.actionInProgress === 'mount' ? 'Mounting...' : 'Mount',
      primaryIcon: 'mount',
      secondaryButtonLabel: this.actionInProgress === 'unmount' ? 'Unmounting...' : 'Unmount',
      secondaryIcon: 'eject',
      actionInProgress: this.actionInProgress?.toString(),
    };
  }

  getPathDisplayConfig(): PathDisplayConfig {
    return {
      source: this.getOperationSource(),
      destination: this.getOperationDestination(),
      showOpenButtons: true,
      operationColor: this.getCurrentOperationColor(),
      isDestinationActive: true,
    };
  }

  getMountPathDisplayConfig(): PathDisplayConfig {
    return {
      source: this.mountSource,
      destination: this.mountDestination,
      showOpenButtons: true,
      operationColor: 'accent',
      isDestinationActive: !!(
        this.selectedRemote?.mountState?.mounted &&
        this.selectedRemote?.mountState?.mounted !== 'error'
      ),
      actionInProgress: this.actionInProgress?.toString(),
    };
  }

  // Updated settings sections
  setupRemoteSettingsSections(): void {
    if (this.isSyncType()) {
      this.remoteSettingsSections = [
        {
          key: this.selectedSyncOperation,
          title: `${this.getCurrentOperationConfig()?.label} Options`,
          icon: this.getCurrentOperationConfig()?.icon || 'sync',
        },
        { key: 'filter', title: 'Filter Options', icon: 'filter' },
      ];
    } else {
      // Mount type
      this.remoteSettingsSections = [
        { key: 'mount', title: 'Mount Options', icon: 'folder' },
        { key: 'vfs', title: 'VFS Options', icon: 'vfs' },
      ];
    }
  }

  // Helper methods for operation state
  getOperationActiveState(): boolean {
    switch (this.mainOperationType) {
      case 'sync':
        return this.getSyncOperationState(this.selectedSyncOperation);
      case 'mount':
        return !!this.selectedRemote?.mountState?.mounted;
      default:
        return false;
    }
  }

  getOperationErrorState(): boolean {
    switch (this.mainOperationType) {
      case 'sync':
        return this.getSyncOperationErrorState(this.selectedSyncOperation);
      case 'mount':
        return this.selectedRemote?.mountState?.mounted === 'error';
      default:
        return false;
    }
  }

  private getSyncOperationState(operation: SyncOperationType): boolean {
    // You'll need to update your Remote interface to include states for each operation
    switch (operation) {
      case 'sync':
        return !!this.selectedRemote?.syncState?.isOnSync;
      case 'bisync':
        return !!this.selectedRemote?.bisyncState?.isOnBisync;
      case 'move':
        return !!this.selectedRemote?.moveState?.isOnMove;
      case 'copy':
        return !!this.selectedRemote?.copyState?.isOnCopy;
      default:
        return false;
    }
  }

  private getSyncOperationErrorState(operation: SyncOperationType): boolean {
    switch (operation) {
      case 'sync':
        return this.selectedRemote?.syncState?.isOnSync === 'error';
      case 'bisync':
        return this.selectedRemote?.bisyncState?.isOnBisync === 'error';
      case 'move':
        return this.selectedRemote?.moveState?.isOnMove === 'error';
      case 'copy':
        return this.selectedRemote?.copyState?.isOnCopy === 'error';
      default:
        return false;
    }
  }

  getCurrentOperationColor(): ThemePalette {
    if (this.isSyncType()) {
      return this.getCurrentOperationConfig()?.color || 'primary';
    }
    return this.mainOperationType === 'mount' ? 'accent' : 'primary';
  }

  private getOperationClass(): string {
    if (this.isSyncType()) {
      return `sync-${this.selectedSyncOperation}-operation`;
    }
    return `${this.mainOperationType}-operation`;
  }

  private getOperationSource(): string {
    const configKey = this.isSyncType()
      ? `${this.selectedSyncOperation}Config`
      : `${this.mainOperationType}Config`;
    return (this.remoteSettings?.[configKey]?.['source'] as string) || 'Need to set!';
  }

  private getOperationDestination(): string {
    const configKey = this.isSyncType()
      ? `${this.selectedSyncOperation}Config`
      : `${this.mainOperationType}Config`;
    return (this.remoteSettings?.[configKey]?.['dest'] as string) || 'Need to set!';
  }

  // Mount-specific getters (unchanged)
  get mountDestination(): string {
    return this.remoteSettings?.['mountConfig']?.['dest'] || 'Need to set!';
  }

  get mountSource(): string {
    return this.remoteSettings?.['mountConfig']?.['source'] || 'Need to set!';
  }

  // Handle operation changes
  private handleOperationChange(): void {
    this.setupRemoteSettingsSections();
    this.handleSelectedRemoteChange();

    if (this.hasCharts()) {
      setTimeout(() => {
        this.initChartsIfNeeded();
      }, 0);
    } else {
      this.destroyCharts();
    }
  }

  // Tab change handler for main tabs
  onMainTabChange(event: { index: number }): void {
    // Handle main tab changes if needed
    if (event.index === 0 && this.hasCharts()) {
      setTimeout(() => {
        this.initChartsIfNeeded();
      }, 0);
    }
  }

  ngOnInit(): void {
    this.setupRemoteSettingsSections();
  }

  ngAfterViewInit(): void {
    this.dataSource.sort = this.sort;
    this.handleSelectedRemoteChange();
    if (this.hasCharts()) {
      setTimeout(() => {
        this.initChartsIfNeeded();
      }, 0);
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (
      changes['mainOperationType'] ||
      changes['selectedSyncOperation'] ||
      changes['selectedRemote']
    ) {
      this.handleOperationChange();
    }
  }

  ngOnDestroy(): void {
    this.cleanUp();
  }

  private getCurrentJobId(): number | undefined {
    if (!this.isSyncType()) return undefined;

    switch (this.selectedSyncOperation) {
      case 'sync':
        return this.selectedRemote?.syncState?.syncJobID;
      case 'bisync':
        return this.selectedRemote?.bisyncState?.bisyncJobID;
      case 'move':
        return this.selectedRemote?.moveState?.moveJobID;
      case 'copy':
        return this.selectedRemote?.copyState?.copyJobID;
      default:
        return undefined;
    }
  }

  private isOperationActive(): boolean {
    return this.getOperationActiveState();
  }

  getJobInfoConfig(): JobInfoConfig {
    return {
      operationType: this.mainOperationType ?? 'mount',
      jobId: this.currentJobId,
      startTime: this.jobStats.startTime ? new Date(this.jobStats.startTime) : undefined,
      lastOperationTime: this.lastSyncDate?.toLocaleString() || undefined,
    };
  }

  getSettingsPanelConfig(section: RemoteSettingsSection): SettingsPanelConfig {
    const configKey = section.key + 'Config';
    const settings = this.getRemoteSettings(configKey);

    return {
      section,
      settings,
      hasSettings: this.hasSettings(configKey),
      restrictMode: this.restrictMode,
      buttonColor: this.mainOperationType === 'sync' ? 'primary' : 'accent',
      buttonLabel: 'Edit Settings',
      sensitiveKeys: SENSITIVE_KEYS,
    };
  }

  getStatsConfig(): StatsPanelConfig {
    const stats: StatItem[] = [
      {
        value: this.formatBytes(this.jobStats.bytes, this.jobStats.totalBytes),
        label: 'Progress',
        isPrimary: true,
        progress: this.calculateProgress(),
      },
      {
        value: this.formatSpeed(this.jobStats.speed),
        label: 'Speed',
      },
      {
        value: this.FormatTimePipe.transform(this.jobStats.eta),
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
        value: this.FormatTimePipe.transform(this.jobStats.elapsedTime),
        label: 'Duration',
      },
    ];

    return {
      title: 'Transfer Statistics',
      icon: 'chart',
      stats,
      operationClass: this.operationClass,
      operationColor: this.operationColor,
    };
  }

  private formatBytes(bytes: number, totalBytes: number): string {
    if (totalBytes > 0) {
      return `${this.FormatFileSizePipe.transform(bytes)} / ${this.FormatFileSizePipe.transform(totalBytes)}`;
    }
    return this.FormatFileSizePipe.transform(bytes);
  }

  private formatSpeed(speed: number): string {
    return `${this.FormatFileSizePipe.transform(speed)}/s`;
  }

  private calculateEtaProgress(): number {
    if (this.jobStats.elapsedTime && this.jobStats.eta) {
      return (this.jobStats.elapsedTime / (this.jobStats.elapsedTime + this.jobStats.eta)) * 100;
    }
    return 0;
  }

  getTransferActivityConfig(): TransferActivityPanelConfig {
    return {
      activeTransfers: this.activeTransfers,
      completedTransfers: this.recentCompletedTransfers,
      operationClass: this.operationClass,
      operationColor: this.mainOperationType === 'sync' ? 'primary' : 'accent',
      remoteName: this.selectedRemote?.remoteSpecs?.name || '',
      showHistory: this.showTransferHistory && this.recentCompletedTransfers.length > 0,
    };
  }

  onEditSettings(event: { section: string; settings: RemoteSettings }): void {
    this.triggerOpenRemoteConfig(event.section, event.settings);
  }

  // Public methods
  triggerOpenInFiles(path: string): void {
    if (this.selectedRemote?.remoteSpecs?.name) {
      this.openInFiles.emit({
        remoteName: this.selectedRemote.remoteSpecs.name,
        path,
      });
    }
  }

  triggerOpenRemoteConfig(editTarget?: string, existingConfig?: RemoteSettings): void {
    this.openRemoteConfigModal.emit({ editTarget, existingConfig });
  }

  // Getters
  get transferSummary(): { total: number; completed: number; active: number } {
    return {
      total: this.jobStats.totalTransfers || 0,
      completed: (this.jobStats.totalTransfers || 0) - (this.jobStats.transfers || 0),
      active: this.jobStats.transferring?.length || 0,
    };
  }

  get errorSummary(): string {
    if (this.jobStats.fatalError) {
      return this.jobStats.lastError || 'Fatal error occurred';
    }
    if (this.jobStats.errors > 0) {
      return `${this.jobStats.errors} error(s) occurred`;
    }
    return '';
  }

  get operationDestination(): string {
    return (
      (this.remoteSettings?.[`${this.mainOperationType}Config`]?.['dest'] as string) ||
      'Need to set!'
    );
  }

  get operationColor(): ThemePalette {
    return this.mainOperationType === 'sync' ? 'primary' : 'accent';
  }

  get operationClass(): string {
    return `${this.mainOperationType}-operation`;
  }

  get operationSource(): string {
    return (
      (this.remoteSettings?.[`${this.mainOperationType}Config`]?.['source'] as string) ||
      'Need to set!'
    );
  }

  // Utility methods
  isLocalPath(path: string): boolean {
    if (!path) return false;
    return (
      /^[a-zA-Z]:[\\/]/.test(path) ||
      path.startsWith('/') ||
      path.startsWith('~/') ||
      path.startsWith('./')
    );
  }

  getFormattedSpeed(): string {
    const { value, unit } = this.getSpeedUnitAndValue(this.jobStats.speed);
    return `${value.toFixed(2)} ${unit}`;
  }

  isSensitiveKey(key: string): boolean {
    return (
      SENSITIVE_KEYS.some(sensitive => key.toLowerCase().includes(sensitive)) && this.restrictMode
    );
  }

  maskSensitiveValue(key: string, value: string): string {
    return this.isSensitiveKey(key) ? 'RESTRICTED' : this.truncateValue(value, 15);
  }

  getRemoteSettings(sectionKey: string): RemoteSettings {
    return this.remoteSettings?.[sectionKey] || {};
  }

  hasSettings(sectionKey: string): boolean {
    return Object.keys(this.getRemoteSettings(sectionKey)).length > 0;
  }

  isObjectButNotArray(value: unknown): boolean {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private handleSelectedRemoteChange(): void {
    this.dataSource.data = [];
    this.currentJobId = this.getCurrentJobId();
    this.resetHistory();

    if (this.isOperationActive()) {
      this.simulateLiveData();
      this.lastSyncDate = new Date();
    } else {
      this.clearDataInterval();
    }

    this.cdr.markForCheck();
  }

  private initCharts(): void {
    this.speedChart = this.createChart(
      this.speedChartRef.nativeElement,
      'Transfer Speed',
      '#4285F4',
      'Speed (B/s)'
    );

    this.progressChart = this.createChart(
      this.progressChartRef.nativeElement,
      'Overall Progress',
      '#34A853',
      'Progress (%)',
      100
    );
  }

  private initChartsIfNeeded(): void {
    this.destroyCharts();
    if (this.speedChartRef?.nativeElement && this.progressChartRef?.nativeElement) {
      this.initCharts();
    }
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
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        scales: {
          x: { display: false },
          y: {
            beginAtZero: true,
            max,
            title: { display: true, text: yAxisTitle },
          },
        },
      },
    });
  }

  private updateChartData(): void {
    // Only update charts if they exist and data changed
    if (!this.speedChart || !this.progressChart) return;

    const progress = this.calculateProgress();
    const speedData = this.getSpeedUnitAndValue(this.jobStats.speed);

    // Check if values actually changed before updating
    const lastProgress = this.progressHistory[this.progressHistory.length - 1] || 0;
    const lastSpeed = this.speedHistory[this.speedHistory.length - 1] || 0;

    if (Math.abs(progress - lastProgress) > 0.5) {
      // Only update if significant change
      this.progressHistory.push(progress);
      if (this.progressHistory.length > this.MAX_HISTORY_LENGTH) {
        this.progressHistory.shift();
      }
      this.progressChart.data.datasets[0].data = [...this.progressHistory];
      this.progressChart.update('none'); // 'none' prevents animation
    }

    if (Math.abs(speedData.value - lastSpeed) > 0.5) {
      // Only update if significant change
      this.speedHistory.push(speedData.value);
      if (this.speedHistory.length > this.MAX_HISTORY_LENGTH) {
        this.speedHistory.shift();
      }
      this.speedChart.data.datasets[0].data = [...this.speedHistory];

      const yScale = this.speedChart.options.scales?.['y'] as { title?: { text: string } };
      if (yScale?.title) {
        yScale.title.text = `Speed (${speedData.unit})`;
      }

      this.speedChart.update('none'); // 'none' prevents animation
    }
  }

  private calculateProgress(): number {
    return this.jobStats.totalBytes > 0
      ? Math.min(100, (this.jobStats.bytes / this.jobStats.totalBytes) * 100)
      : 0;
  }

  private getSpeedUnitAndValue(speedInBps: number): {
    value: number;
    unit: string;
  } {
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let speed = speedInBps;
    let unitIndex = 0;

    while (speed >= 1024 && unitIndex < units.length - 1) {
      speed /= 1024;
      unitIndex++;
    }

    return { value: speed, unit: units[unitIndex] };
  }

  private simulateLiveData(): void {
    this.clearDataInterval();

    // Run outside Angular zone to prevent unnecessary change detection
    this.ngZone.runOutsideAngular(() => {
      this.dataInterval = window.setInterval(() => {
        if (!this.isOperationActive() || !this.currentJobId) {
          return;
        }

        // Only run change detection when we have new data
        this.fetchJobStatus();
        this.cdr.detectChanges();
      }, this.POLLING_INTERVAL);
    });
  }
  private fetchJobStatus(): void {
    if (!this.currentJobId || !this.selectedRemote?.remoteSpecs?.name) {
      return;
    }

    // Use remote-specific job stats instead of global stats
    const remoteName = this.selectedRemote.remoteSpecs.name;
    const group = `job/${this.currentJobId}`;

    Promise.all([
      this.jobManagementService.getJobStatus(this.currentJobId),
      this.jobManagementService.getCoreStatsForRemote(remoteName, this.currentJobId),
      this.loadCompletedTransfers(group),
    ])
      .then(([job, remoteStats, completedTransfers]) => {
        if (job) {
          this.ngZone.run(() => {
            // Use remote-specific stats if available, otherwise use job stats
            let statsToUse = job;
            if (remoteStats) {
              // Adapt remote stats to match expected job structure
              statsToUse = {
                ...job,
                stats: remoteStats,
              };
            }

            console.log('Stats to use:', statsToUse);
            this.updateStatsFromJob(statsToUse);
            if (completedTransfers) {
              this.updateCompletedTransfers(completedTransfers);
            }
          });
        }
      })
      .catch(error => console.error('Error fetching remote-specific job status:', error));
  }

  public async loadCompletedTransfers(group: string): Promise<CompletedTransfer[] | null> {
    try {
      const response: any = await this.jobManagementService.getCompletedTransfers(group);
      if (response && response.transferred && Array.isArray(response.transferred)) {
        this.showTransferHistory = true;
        return response.transferred.map((transfer: any) => this.mapTransferFromApi(transfer));
      } else if (response && Array.isArray(response)) {
        // Handle case where response is directly an array
        this.showTransferHistory = true;
        return response.map((transfer: any) => this.mapTransferFromApi(transfer));
      }
      return null;
    } catch (error) {
      console.warn('Could not load completed transfers:', error);
      return null;
    }
  }

  private mapTransferFromApi(transfer: any): CompletedTransfer {
    // Determine status based on API data
    let status: 'completed' | 'checked' | 'failed' | 'partial' = 'completed';

    if (transfer.error && transfer.error !== '') {
      status = 'failed';
    } else if (transfer.checked === true) {
      status = 'checked';
    } else if (transfer.bytes > 0 && transfer.bytes < transfer.size) {
      status = 'partial';
    } else if (transfer.bytes === transfer.size && transfer.size > 0) {
      status = 'completed';
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
      status: status,
    };
  }

  private updateCompletedTransfers(transfers: CompletedTransfer[]): void {
    // Only update if there are actual changes
    if (JSON.stringify(transfers) !== JSON.stringify(this.recentCompletedTransfers)) {
      this.recentCompletedTransfers = transfers
        .sort((a, b) => {
          const aTime = a.completedAt ? new Date(a.completedAt).getTime() : 0;
          const bTime = b.completedAt ? new Date(b.completedAt).getTime() : 0;
          return bTime - aTime;
        })
        .slice(0, 20);
      this.cdr.markForCheck();
    }
  }

  private updateStatsFromJob(job: any): void {
    if (!job.stats) return;

    // Track completed transfers when the count increases
    const currentTransferCount = job.stats.transfers || 0;
    if (currentTransferCount > this.lastTransferCount) {
      // New transfers have completed - find files that are no longer transferring but were in progress
      const currentTransferring = job.stats.transferring || [];
      const activeNames = new Set(currentTransferring.map((f: any) => f.name));

      // Find files that were transferring but are no longer in the active list
      const currentActiveTransfers = this.dataSource.data.filter(file => !file.isCompleted);
      currentActiveTransfers.forEach(file => {
        if (!activeNames.has(file.name) && file.percentage > 0 && file.percentage < 100) {
          // This file was transferring but is no longer active, mark as completed
          const completedFile: TransferFile = {
            ...file,
            percentage: 100,
            speed: 0,
            eta: 0,
            isError: false,
            isCompleted: true,
          };

          // Only add if not already in completed list
          if (!this.completedTransfers.some(cf => cf.name === file.name)) {
            this.completedTransfers.push(completedFile);
          }
        }
      });

      this.lastTransferCount = currentTransferCount;
    }

    const updatedStats = {
      ...job.stats,
      transferring: this.processTransferringFiles(job.stats.transferring),
    };
    console.log('Updated Job Stats:', updatedStats);
    console.log('Completed Transfers:', this.completedTransfers.length);

    this.jobStats = updatedStats;
    this.updateRemoteStatusOnError(job);
    this.updateChartData();

    // Process active transfers separately
    const activeTransfers = this.processTransferringFiles(job.stats.transferring);

    // Store active transfers separately for the enhanced panel
    this.activeTransfers = activeTransfers;

    // Combine active transfers with completed transfers for backward compatibility with old UI
    const allTransfers = [...activeTransfers, ...this.completedTransfers];
    this.dataSource.data = allTransfers;

    console.log('Active transfers:', activeTransfers.length);
    console.log('Completed transfers:', this.recentCompletedTransfers.length);

    this.cdr.markForCheck();
  }

  private processTransferringFiles(files: any[] = []): TransferFile[] {
    return (files as TransferFile[]).map(file => ({
      ...file,
      percentage: file.size > 0 ? Math.min(100, Math.round((file.bytes / file.size) * 100)) : 0,
      isError: file.percentage === 100 && file.bytes < file.size,
    }));
  }

  private updateRemoteStatusOnError(job: any): void {
    if (job.stats.fatalError && this.selectedRemote) {
      const stateKey = this.mainOperationType === 'sync' ? 'syncState' : 'copyState';

      this.selectedRemote = {
        ...this.selectedRemote,
        [stateKey]: {
          isOnSync: 'error',
        },
      };
    }
  }

  private resetHistory(): void {
    this.progressHistory = [];
    this.speedHistory = [];
    this.completedTransfers = [];
    this.activeTransfers = [];
    this.lastTransferCount = 0;
  }

  private clearDataInterval(): void {
    if (this.dataInterval) {
      clearInterval(this.dataInterval);
      this.dataInterval = undefined;
    }
  }

  private cleanUp(): void {
    this.clearDataInterval();
    this.destroyCharts();
    this.jobSubscription?.unsubscribe();

    // Reset completed transfers when cleaning up
    this.completedTransfers = [];
    this.lastTransferCount = 0;
  }

  private destroyCharts(): void {
    this.speedChart?.destroy();
    this.progressChart?.destroy();
  }

  private truncateValue(value: any, length: number): string {
    if (value == null) return '';

    if (typeof value === 'object') {
      try {
        const jsonString = JSON.stringify(value);
        return jsonString.length > length ? `${jsonString.slice(0, length)}...` : jsonString;
      } catch {
        return '[Invalid JSON]';
      }
    }

    const stringValue = String(value);
    return stringValue.length > length ? `${stringValue.slice(0, length)}...` : stringValue;
  }

  onTabChange(event: { index: number }): void {
    // When monitoring tab is selected (index 0), initialize charts if needed
    if (event.index === 0 && this.mainOperationType === 'sync') {
      setTimeout(() => {
        this.initChartsIfNeeded();
      }, 0);
    }
  }
}
