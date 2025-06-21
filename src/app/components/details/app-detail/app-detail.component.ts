import { CommonModule } from "@angular/common";
import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  NgZone,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
  OnInit,
  PipeTransform,
  Pipe,
} from "@angular/core";
import { MatIconModule } from "@angular/material/icon";
import { MatTooltipModule } from "@angular/material/tooltip";
import { Chart, registerables } from "chart.js";
import { MatDividerModule } from "@angular/material/divider";
import { MatCardModule } from "@angular/material/card";
import { MatChipsModule } from "@angular/material/chips";
import { MatButtonModule } from "@angular/material/button";
import { MatTabsModule } from "@angular/material/tabs";
import { MatSlideToggleModule } from "@angular/material/slide-toggle";
import { Subscription } from "rxjs";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { MatFormFieldModule } from "@angular/material/form-field";
import { FormsModule } from "@angular/forms";
import { MatTableModule } from "@angular/material/table";
import { MatTableDataSource } from "@angular/material/table";
import { MatSort, MatSortModule } from "@angular/material/sort";
import { ThemePalette } from "@angular/material/core";
import {
  Remote,
  RemoteAction,
  RemoteSettings,
  RemoteSettingsSection,
  SENSITIVE_KEYS,
  GlobalStats,
  TransferFile,
  DEFAULT_JOB_STATS,
} from "../../../shared/components/types";
import {
  OperationControlComponent,
  OperationControlConfig,
  JobInfoPanelComponent,
  JobInfoConfig,
  StatsPanelComponent,
  StatsPanelConfig,
  StatItem,
  SettingsPanelComponent,
  SettingsPanelConfig,
  PathDisplayConfig,
  FileTransferPanelComponent,
  FileTransferPanelConfig
} from "../shared";

@Pipe({ name: "formatTime", standalone: true })
export class FormatTimePipe implements PipeTransform {
  transform(seconds: number): string {
    if (isNaN(seconds) || seconds <= 0) return "-";

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
    parts.push(`${secs}s`);

    return parts.join(" ");
  }
}

@Pipe({ name: "filesize", standalone: true })
export class FileSizePipe implements PipeTransform {
  transform(
    bytes: number = 0,
    precision: number = 2,
    mode: "size" | "speed" = "size"
  ): string {
    if (isNaN(parseFloat(String(bytes))) || !isFinite(bytes)) {
      return mode === "speed" ? "0 B/s" : "0 B";
    }

    const units = ["B", "KB", "MB", "GB", "TB"];
    let unitIndex = 0;

    while (bytes >= 1024 && unitIndex < units.length - 1) {
      bytes /= 1024;
      unitIndex++;
    }

    return `${bytes.toFixed(precision)} ${units[unitIndex]}${
      mode === "speed" ? "/s" : ""
    }`;
  }
}

@Component({
  selector: "app-app-detail",
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
    MatSlideToggleModule,
    MatProgressSpinnerModule,
    MatProgressBarModule,
    MatFormFieldModule,
    FormsModule,
    MatTableModule,
    MatSortModule,
    OperationControlComponent,
    JobInfoPanelComponent,
    StatsPanelComponent,
    SettingsPanelComponent,
    FileTransferPanelComponent,
  ],
  templateUrl: "./app-detail.component.html",
  styleUrls: ["./app-detail.component.scss"],
})
export class AppDetailComponent implements OnInit, AfterViewInit, OnDestroy {
  @Input() operationType?: "sync" | "copy" | "mount"; // Only for operation type
  @Input() selectedRemote: Remote | null = null;
  @Input() remoteSettings: RemoteSettings = {};
  @Input() restrictMode!: boolean;
  @Input() iconService!: any;
  @Input() jobManagementService?: any; // Only for operation type
  @Input() actionInProgress?: RemoteAction | null; // Only for mount type

  // Operation specific outputs
  @Output() primaryAction = new EventEmitter<string>();
  @Output() secondaryAction = new EventEmitter<string>();

  // Common outputs
  @Output() openRemoteConfigModal = new EventEmitter<{
    editTarget?: string;
    existingConfig?: any;
  }>();
  @Output() openInFiles = new EventEmitter<{
    remoteName: string;
    path: string;
  }>();

  @ViewChild(MatSort) sort!: MatSort;
  @ViewChild("speedChart") speedChartRef!: ElementRef;
  @ViewChild("progressChart") progressChartRef!: ElementRef;

  // Operation specific properties
  dataSource = new MatTableDataSource<TransferFile>([]);
  displayedColumns: string[] = ["name", "percentage", "speed", "size", "eta"];
  jobStats: GlobalStats = { ...DEFAULT_JOB_STATS };
  currentJobId?: number;
  isLoading = false;
  errorMessage = "";
  lastSyncTime = "";
  dryRun = false;

  private speedChart!: Chart;
  private progressChart!: Chart;
  private dataInterval?: number;
  private speedHistory: number[] = [];
  private progressHistory: number[] = [];
  private jobSubscription?: Subscription;

  remoteSettingsSections: RemoteSettingsSection[] = [];
  readonly MAX_HISTORY_LENGTH = 30;
  readonly POLLING_INTERVAL = 1000;

  constructor(
    private ngZone: NgZone,
    private cdr: ChangeDetectorRef,
  ) {
    Chart.register(...registerables);
  }

  ngOnInit(): void {
    this.setupRemoteSettingsSections();
  }

  ngAfterViewInit(): void {
    if (this.isOperationType()) {
      this.initCharts();
      this.dataSource.sort = this.sort;
    }
    this.handleSelectedRemoteChange();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes["operationType"] || changes["selectedRemote"]) {
      this.setupRemoteSettingsSections();
      this.handleSelectedRemoteChange();
    }
  }

  ngOnDestroy(): void {
    this.cleanUp();
  }

  // Type checking helpers
  isOperationType(): boolean {
    return this.operationType === 'sync' || this.operationType === 'copy';
  }

  isMountType(): boolean {
    return this.operationType === 'mount';
  }

  // Operation specific methods
  get operationColor(): ThemePalette {
    if (this.operationType === 'mount') return 'accent';
    return this.operationType === "sync" ? "primary" : "accent";
  }

  get operationClass(): string {
    if (this.operationType === 'mount') return 'mount-operation';
    return this.operationType === "sync" ? "sync-operation" : "copy-operation";
  }

  get operationSource(): string {
    const configKey = `${this.operationType}Config`;
    return this.remoteSettings?.[configKey]?.["source"] || "Need to set!";
  }

  get operationDestination(): string {
    const configKey = `${this.operationType}Config`;
    return this.remoteSettings?.[configKey]?.["dest"] || "Need to set!";
  }

  // Primary action handler (Start operation/Mount)
  handlePrimaryAction(): void {
    if (this.selectedRemote?.remoteSpecs?.name) {
      this.primaryAction.emit(this.selectedRemote.remoteSpecs.name);
    }
  }

  // Secondary action handler (Stop operation/Unmount)
  handleSecondaryAction(): void {
    if (this.selectedRemote?.remoteSpecs?.name) {
      this.secondaryAction.emit(this.selectedRemote.remoteSpecs.name);
    }
  }

  toggleDryRun(): void {
    this.dryRun = !this.dryRun;
  }

  getFormattedSpeed(): string {
    return `${this.jobStats.speed || 0}`;
  }

  // Mount specific methods
  get mountDestination(): string {
    return this.remoteSettings?.["mountConfig"]?.["dest"] || "Need to set!";
  }

  get mountSource(): string {
    return this.remoteSettings?.["mountConfig"]?.["source"] || "Need to set!";
  }

  // Common methods
  triggerOpenRemoteConfig(editTarget?: string, existingConfig?: any): void {
    this.openRemoteConfigModal.emit({ editTarget, existingConfig });
  }

  isLocalPath(path: string): boolean {
    return !!(path && (path.startsWith("/") || path.match(/^[A-Za-z]:\\/)));
  }

  // Remote Settings Helpers
  setupRemoteSettingsSections(): void {
    if (this.isOperationType()) {
      this.remoteSettingsSections = [
        { key: this.operationType!, title: `${this.operationType} Options`, icon: this.operationType! },
        { key: "vfs", title: "VFS Options", icon: "vfs" },
      ];
    } else {
      this.remoteSettingsSections = [
        { key: "mount", title: "Mount Options", icon: "mount" },
        { key: "vfs", title: "VFS Options", icon: "vfs" },
      ];
    }
  }

  getRemoteSettings(sectionKey: string): RemoteSettings {
    return this.remoteSettings?.[sectionKey] || {};
  }

  hasSettings(sectionKey: string): boolean {
    return Object.keys(this.getRemoteSettings(sectionKey)).length > 0;
  }

  isObjectButNotArray(value: any): boolean {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  isSensitiveKey(key: string): boolean {
    return (
      SENSITIVE_KEYS.some((sensitive) =>
        key.toLowerCase().includes(sensitive)
      ) && this.restrictMode
    );
  }

  maskSensitiveValue(key: string, value: any): string {
    return this.isSensitiveKey(key) ? "RESTRICTED" : this.truncateValue(value, 15);
  }

  private truncateValue(value: any, length: number): string {
    if (value === null || value === undefined) return "";

    if (typeof value === "object") {
      try {
        const jsonString = JSON.stringify(value);
        return jsonString.length > length
          ? `${jsonString.slice(0, length)}...`
          : jsonString;
      } catch {
        return "[Invalid JSON]";
      }
    }

    const stringValue = String(value);
    return stringValue.length > length
      ? `${stringValue.slice(0, length)}...`
      : stringValue;
  }

  // Configuration builders for child components
  getOperationControlConfig(): OperationControlConfig {
    const isActive = this.operationType === 'sync' ? 
      !!this.selectedRemote?.syncState?.isOnSync : 
      !!this.selectedRemote?.copyState?.isOnCopy;
    
    const isError = this.operationType === 'sync' ? 
      this.selectedRemote?.syncState?.isOnSync === 'error' : 
      this.selectedRemote?.copyState?.isOnCopy === 'error';

    return {
      operationType: this.operationType!,
      isActive,
      isError,
      isLoading: this.isLoading,
      operationColor: this.operationColor,
      operationClass: this.operationClass,
      pathConfig: this.getPathDisplayConfig(),
      primaryButtonLabel: `Start ${this.operationType}`,
      secondaryButtonLabel: `Stop ${this.operationType}`,
      actionInProgress: this.actionInProgress?.toString()
    };
  }

  getMountControlConfig(): OperationControlConfig {
    const isActive = !!(this.selectedRemote?.mountState?.mounted && 
                       this.selectedRemote?.mountState?.mounted !== 'error');
    
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
      actionInProgress: this.actionInProgress?.toString()
    };
  }

  getPathDisplayConfig(): PathDisplayConfig {
    return {
      source: this.operationSource,
      destination: this.operationDestination,
      showOpenButtons: true,
      operationColor: this.operationColor,
      isDestinationActive: true // For operations, destination is always accessible
    };
  }

  getMountPathDisplayConfig(): PathDisplayConfig {
    return {
      source: this.mountSource,
      destination: this.mountDestination,
      showOpenButtons: true,
      operationColor: 'accent',
      isDestinationActive: !!(this.selectedRemote?.mountState?.mounted && 
                             this.selectedRemote?.mountState?.mounted !== 'error'),
      actionInProgress: this.actionInProgress?.toString()
    };
  }

  getJobInfoConfig(): JobInfoConfig {
    return {
      operationType: this.operationType!,
      jobId: this.currentJobId,
      startTime: this.jobStats.startTime ? new Date(this.jobStats.startTime) : undefined,
      lastOperationTime: this.lastSyncTime ? new Date(this.lastSyncTime).toLocaleString() : undefined
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
      sensitiveKeys: SENSITIVE_KEYS
    };
  }

  getStatsConfig(): StatsPanelConfig {
    const stats: StatItem[] = [
      {
        value: `${this.jobStats.bytes || 0}`,
        label: 'Transferred',
        isPrimary: true,
        progress: this.jobStats.totalBytes > 0 ? 
          (this.jobStats.bytes / this.jobStats.totalBytes) * 100 : 0
      },
      {
        value: `${this.jobStats.totalBytes || 0}`,
        label: 'Total Size'
      },
      {
        value: this.getFormattedSpeed(),
        label: 'Speed'
      },
      {
        value: `${this.jobStats.elapsedTime || 0}`,
        label: 'Elapsed Time'
      },
      {
        value: `${this.jobStats.eta || 0}`,
        label: 'ETA',
        isPrimary: true,
        progress: this.jobStats.elapsedTime && this.jobStats.eta ? 
          (this.jobStats.elapsedTime / (this.jobStats.elapsedTime + this.jobStats.eta)) * 100 : 0
      },
      {
        value: this.jobStats.errors || 0,
        label: 'Errors',
        hasError: (this.jobStats.errors || 0) > 0,
        tooltip: this.jobStats.lastError ? `Last Error: ${this.jobStats.lastError}` : undefined
      }
    ];

    return {
      title: 'Transfer Statistics',
      icon: 'chart',
      stats,
      operationClass: this.operationClass,
      operationColor: this.operationColor
    };
  }

  getFileTransferConfig(): FileTransferPanelConfig {
    return {
      dataSource: this.dataSource,
      displayedColumns: this.displayedColumns,
      operationClass: this.operationClass
    };
  }

  // Operation specific chart and data handling methods (from original operation component)
  private handleSelectedRemoteChange(): void {
    if (this.isOperationType()) {
      this.cleanUp();
      this.loadJobData();
      this.updateTransferFiles();
      this.startPolling();
    }
  }

  private initCharts(): void {
    if (!this.isOperationType()) return;

    this.ngZone.runOutsideAngular(() => {
      // Initialize speed chart
      if (this.speedChartRef?.nativeElement) {
        this.speedChart = new Chart(this.speedChartRef.nativeElement, {
          type: "line",
          data: {
            labels: Array.from({ length: this.MAX_HISTORY_LENGTH }, (_, i) => i),
            datasets: [
              {
                label: "Speed (MB/s)",
                data: this.speedHistory,
                borderColor: this.operationType === "sync" ? "#3f51b5" : "#ff4081",
                backgroundColor: this.operationType === "sync" ? "#3f51b530" : "#ff408130",
                tension: 0.4,
                fill: true,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              y: { beginAtZero: true },
              x: { display: false },
            },
            plugins: { legend: { display: false } },
          },
        });
      }

      // Initialize progress chart
      if (this.progressChartRef?.nativeElement) {
        this.progressChart = new Chart(this.progressChartRef.nativeElement, {
          type: "line",
          data: {
            labels: Array.from({ length: this.MAX_HISTORY_LENGTH }, (_, i) => i),
            datasets: [
              {
                label: "Progress (%)",
                data: this.progressHistory,
                borderColor: this.operationType === "sync" ? "#4caf50" : "#ffc107",
                backgroundColor: this.operationType === "sync" ? "#4caf5030" : "#ffc10730",
                tension: 0.4,
                fill: true,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              y: { beginAtZero: true, max: 100 },
              x: { display: false },
            },
            plugins: { legend: { display: false } },
          },
        });
      }
    });
  }

  private loadJobData(): void {
    // Implementation would depend on your jobManagementService
    // This is a placeholder for the original functionality
  }

  private updateTransferFiles(): void {
    // Implementation would depend on your data source
    // This is a placeholder for the original functionality
  }

  private startPolling(): void {
    if (this.dataInterval) {
      clearInterval(this.dataInterval);
    }

    this.dataInterval = window.setInterval(() => {
      if (this.isOperationType()) {
        this.updateChartsData();
      }
    }, this.POLLING_INTERVAL);
  }

  private updateChartsData(): void {
    if (!this.isOperationType()) return;

    const speedMBps = (this.jobStats.speed || 0) / (1024 * 1024);
    const progressPercent = this.jobStats.totalBytes > 0 
      ? (this.jobStats.bytes / this.jobStats.totalBytes) * 100 
      : 0;

    this.speedHistory.push(speedMBps);
    this.progressHistory.push(progressPercent);

    if (this.speedHistory.length > this.MAX_HISTORY_LENGTH) {
      this.speedHistory.shift();
      this.progressHistory.shift();
    }

    this.ngZone.runOutsideAngular(() => {
      this.speedChart?.update("none");
      this.progressChart?.update("none");
    });
  }

  private cleanUp(): void {
    if (this.dataInterval) {
      clearInterval(this.dataInterval);
      this.dataInterval = undefined;
    }

    if (this.jobSubscription) {
      this.jobSubscription.unsubscribe();
      this.jobSubscription = undefined;
    }

    if (this.speedChart) {
      this.speedChart.destroy();
    }

    if (this.progressChart) {
      this.progressChart.destroy();
    }
  }

  onEditSettings(event: { section: string; settings: any }): void {
    this.triggerOpenRemoteConfig(event.section, event.settings);
  }

  // Fixed triggerOpenInFiles method to handle string parameter correctly
  triggerOpenInFiles(path?: string): void {
    if (!this.selectedRemote?.remoteSpecs?.name) return;

    let targetPath: string;
    
    if (path) {
      targetPath = path;
    } else if (this.isMountType()) {
      targetPath = this.mountDestination;
    } else {
      // For operations, we need the path parameter
      return;
    }

    this.openInFiles.emit({
      remoteName: this.selectedRemote.remoteSpecs.name,
      path: targetPath,
    });
  }
}
