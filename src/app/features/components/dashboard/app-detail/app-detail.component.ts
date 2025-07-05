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
import { JobManagementService } from '../../../../services/file-operations/job-management.service';
import {
  CompletedTransfer,
  JobInfoConfig,
  JobInfoPanelComponent,
  OperationControlComponent,
  OperationControlConfig,
  PathDisplayConfig,
  SettingsPanelComponent,
  SettingsPanelConfig,
  StatItem,
  StatsPanelComponent,
  StatsPanelConfig,
  TransferActivityPanelComponent,
  TransferActivityPanelConfig,
} from '../../../../shared/detail-shared';
import { IconService } from '../../../../services/ui/icon.service';

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
  @Input() operationType?: 'sync' | 'copy' | 'mount'; // Only for operation type
  @Input() selectedRemote: Remote | null = null;
  @Input() remoteSettings: RemoteSettings = {};
  @Input() restrictMode!: boolean;
  @Input() iconService!: IconService;
  @Input() actionInProgress?: RemoteAction | null; // Only for mount type

  // Operation specific outputs
  @Output() primaryAction = new EventEmitter<string>();
  @Output() secondaryAction = new EventEmitter<string>();

  // Common outputs
  @Output() openRemoteConfigModal = new EventEmitter<{
    editTarget?: string;
    existingConfig?: RemoteSettings;
  }>();
  @Output() openInFiles = new EventEmitter<{
    remoteName: string;
    path: string;
  }>();

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
  lastSyncTime = '';

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

  // // Type checking helpers
  isOperationType(): boolean {
    return this.operationType === 'sync' || this.operationType === 'copy';
  }

  // // Primary action handler (Start operation/Mount)
  handlePrimaryAction(): void {
    if (this.selectedRemote?.remoteSpecs?.name) {
      this.primaryAction.emit(this.selectedRemote.remoteSpecs.name);
    }
  }

  // // Secondary action handler (Stop operation/Unmount)
  handleSecondaryAction(): void {
    if (this.selectedRemote?.remoteSpecs?.name) {
      this.secondaryAction.emit(this.selectedRemote.remoteSpecs.name);
    }
  }

  formatTime(seconds: number): string {
    if (isNaN(seconds) || seconds <= 0) return '-';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
    parts.push(`${secs}s`);

    return parts.join(' ');
  }

  formatFileSizePipe(bytes = 0, precision = 2, mode: 'size' | 'speed' = 'size'): string {
    if (isNaN(parseFloat(String(bytes))) || !isFinite(bytes)) {
      return mode === 'speed' ? '0 B/s' : '0 B';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unitIndex = 0;

    while (bytes >= 1024 && unitIndex < units.length - 1) {
      bytes /= 1024;
      unitIndex++;
    }

    return `${bytes.toFixed(precision)} ${units[unitIndex]}${mode === 'speed' ? '/s' : ''}`;
  }

  // // Mount specific methods
  get mountDestination(): string {
    return this.remoteSettings?.['mountConfig']?.['dest'] || 'Need to set!';
  }

  get mountSource(): string {
    return this.remoteSettings?.['mountConfig']?.['source'] || 'Need to set!';
  }

  // // Remote Settings Helpers
  setupRemoteSettingsSections(): void {
    if (this.isOperationType()) {
      this.remoteSettingsSections = [
        {
          key: this.operationType ?? '',
          title: `${this.operationType ?? ''} Options`,
          icon: this.operationType ?? '',
        },
        { key: 'filter', title: 'Filter Options', icon: 'filter' },
      ];
    } else {
      this.remoteSettingsSections = [
        { key: 'mount', title: 'Mount Options', icon: 'mount' },
        { key: 'vfs', title: 'VFS Options', icon: 'vfs' },
      ];
    }
  }

  // // Configuration builders for child components
  getOperationControlConfig(): OperationControlConfig {
    const isActive =
      this.operationType === 'sync'
        ? !!this.selectedRemote?.syncState?.isOnSync
        : !!this.selectedRemote?.copyState?.isOnCopy;

    const isError =
      this.operationType === 'sync'
        ? this.selectedRemote?.syncState?.isOnSync === 'error'
        : this.selectedRemote?.copyState?.isOnCopy === 'error';

    return {
      operationType: this.operationType ?? 'mount',
      isActive,
      isError,
      isLoading: this.isLoading,
      operationColor: this.operationColor,
      operationClass: this.operationClass,
      pathConfig: this.getPathDisplayConfig(),
      primaryButtonLabel: `Start ${this.operationType}`,
      secondaryButtonLabel: `Stop ${this.operationType}`,
      actionInProgress: this.actionInProgress?.toString(),
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
      secondaryButtonLabel: this.actionInProgress === 'unmount' ? 'Unmounting...' : 'Unmount',
      actionInProgress: this.actionInProgress?.toString(),
    };
  }

  getPathDisplayConfig(): PathDisplayConfig {
    return {
      source: this.operationSource,
      destination: this.operationDestination,
      showOpenButtons: true,
      operationColor: this.operationColor,
      isDestinationActive: true, // For operations, destination is always accessible
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

  getJobInfoConfig(): JobInfoConfig {
    return {
      operationType: this.operationType ?? 'mount',
      jobId: this.currentJobId,
      startTime: this.jobStats.startTime ? new Date(this.jobStats.startTime) : undefined,
      lastOperationTime: this.lastSyncTime
        ? new Date(this.lastSyncTime).toLocaleString()
        : undefined,
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
      buttonColor: this.isOperationType() ? 'primary' : 'accent',
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
        value: this.formatTime(this.jobStats.eta),
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
        value: this.formatTime(this.jobStats.elapsedTime),
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

  // Add these new helper methods to the component
  private formatBytes(bytes: number, totalBytes: number): string {
    if (totalBytes > 0) {
      return `${this.formatFileSize(bytes)} / ${this.formatFileSize(totalBytes)}`;
    }
    return this.formatFileSize(bytes);
  }

  private formatSpeed(speed: number): string {
    return `${this.formatFileSize(speed)}/s`;
  }

  private formatFileSize(bytes: number): string {
    if (bytes <= 0) return '0 B';

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 2 : 0)} ${units[i]}`;
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
      operationColor: this.operationType === 'sync' ? 'primary' : 'accent',
      remoteName: this.selectedRemote?.remoteSpecs?.name || '',
      showHistory: this.showTransferHistory && this.recentCompletedTransfers.length > 0,
    };
  }

  onEditSettings(event: { section: string; settings: RemoteSettings }): void {
    this.triggerOpenRemoteConfig(event.section, event.settings);
  }

  ngOnInit(): void {
    this.setupRemoteSettingsSections();
  }

  ngAfterViewInit(): void {
    this.dataSource.sort = this.sort;
    this.handleSelectedRemoteChange();
    // Initialize charts after view is stable if operation type requires charts
    if (this.isOperationType()) {
      // Use setTimeout to ensure the DOM is fully rendered
      setTimeout(() => {
        this.initChartsIfNeeded();
      }, 0);
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['operationType'] || changes['selectedRemote']) {
      this.setupRemoteSettingsSections();
      this.handleSelectedRemoteChange();

      // Handle chart lifecycle based on operation type changes
      if (changes['operationType']) {
        if (this.isOperationType()) {
          // Initialize charts if switching to sync/copy
          setTimeout(() => {
            this.initChartsIfNeeded();
          }, 0);
        } else {
          // Destroy charts if switching to mount
          this.destroyCharts();
        }
      }
    }
  }

  ngOnDestroy(): void {
    this.cleanUp();
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
      (this.remoteSettings?.[`${this.operationType}Config`]?.['dest'] as string) || 'Need to set!'
    );
  }

  get operationColor(): ThemePalette {
    return this.operationType === 'sync' ? 'primary' : 'accent';
  }

  get operationClass(): string {
    return `${this.operationType}-operation`;
  }

  get operationSource(): string {
    return (
      (this.remoteSettings?.[`${this.operationType}Config`]?.['source'] as string) || 'Need to set!'
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

  // Private methods
  private isOperationActive(): boolean {
    return this.operationType === 'sync'
      ? !!this.selectedRemote?.syncState?.isOnSync
      : !!this.selectedRemote?.copyState?.isOnCopy;
  }

  private getCurrentJobId(): number | undefined {
    return this.operationType === 'sync'
      ? this.selectedRemote?.syncState?.syncJobID
      : this.selectedRemote?.copyState?.copyJobID;
  }

  private handleSelectedRemoteChange(): void {
    this.dataSource.data = [];
    this.currentJobId = this.getCurrentJobId();
    this.resetHistory();

    if (this.isOperationActive()) {
      this.simulateLiveData();
      this.lastSyncTime = new Date().toLocaleString();
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
    // Only initialize charts if they don't exist and we can access the chart elements
    if (
      !this.speedChart &&
      !this.progressChart &&
      this.speedChartRef?.nativeElement &&
      this.progressChartRef?.nativeElement
    ) {
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
    // Initialize charts if they don't exist but should exist
    if (this.isOperationType() && !this.speedChart && !this.progressChart) {
      this.initChartsIfNeeded();
    }

    // Only update if charts exist
    if (this.speedChart && this.progressChart) {
      this.updateSpeedChart();
      this.updateProgressChart();
    }
  }

  private updateSpeedChart(): void {
    if (!this.speedChart) return;

    const speedData = this.getSpeedUnitAndValue(this.jobStats.speed);
    const speedInSelectedUnit = speedData.value;

    this.speedHistory.push(speedInSelectedUnit);
    if (this.speedHistory.length > this.MAX_HISTORY_LENGTH) {
      this.speedHistory.shift();
    }

    this.speedChart.data.datasets[0].data = [...this.speedHistory];

    const yScale = this.speedChart.options.scales?.['y'] as { title?: { text: string } };
    if (yScale?.title) {
      yScale.title.text = `Speed (${speedData.unit})`;
    }

    this.speedChart.update();
  }

  private updateProgressChart(): void {
    if (!this.progressChart) return;

    const progress = this.calculateProgress();

    this.progressHistory.push(progress);
    if (this.progressHistory.length > this.MAX_HISTORY_LENGTH) {
      this.progressHistory.shift();
    }

    this.progressChart.data.datasets[0].data = [...this.progressHistory];
    this.progressChart.update();
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

    this.dataInterval = window.setInterval(() => {
      if (!this.isOperationActive() || !this.currentJobId) {
        return;
      }

      this.fetchJobStatus();
    }, this.POLLING_INTERVAL);
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
    // Keep only the most recent 20 completed transfers
    this.recentCompletedTransfers = transfers
      .sort((a, b) => {
        const aTime = a.completedAt ? new Date(a.completedAt).getTime() : 0;
        const bTime = b.completedAt ? new Date(b.completedAt).getTime() : 0;
        return bTime - aTime; // Most recent first
      })
      .slice(0, 20);
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
      const stateKey = this.operationType === 'sync' ? 'syncState' : 'copyState';

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
    if (event.index === 0 && this.isOperationType()) {
      setTimeout(() => {
        this.initChartsIfNeeded();
      }, 0);
    }
  }
}
