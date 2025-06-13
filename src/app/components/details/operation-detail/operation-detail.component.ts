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
import { IconService } from "../../../services/icon.service";
import { MatSlideToggleModule } from "@angular/material/slide-toggle";
import { Subscription } from "rxjs";
import { RcloneService } from "../../../services/rclone.service";
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
  RemoteSettings,
  RemoteSettingsSection,
  SENSITIVE_KEYS,
  GlobalStats,
  TransferFile,
} from "../../../shared/components/types";

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
  selector: "app-operation-detail",
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
    FileSizePipe,
    FormatTimePipe,
  ],
  templateUrl: "./operation-detail.component.html",
  styleUrls: ["./operation-detail.component.scss"],
})
export class OperationDetailComponent
  implements OnInit, AfterViewInit, OnDestroy
{
  @Input() operationType!: "sync" | "copy";
  @Input() selectedRemote: Remote | null = null;
  @Input() remoteSettings: RemoteSettings = {};
  @Input() restrictMode!: boolean;

  @Output() openRemoteConfigModal = new EventEmitter<{
    editTarget?: string;
    existingConfig?: any;
  }>();
  @Output() openInFiles = new EventEmitter<{
    remoteName: string;
    path: string;
  }>();
  @Output() startOperation = new EventEmitter<{
    type: "sync" | "copy";
    remoteName: string;
  }>();
  @Output() stopOperation = new EventEmitter<{
    type: "sync" | "copy";
    remoteName: string;
  }>();

  @ViewChild(MatSort) sort!: MatSort;
  @ViewChild("speedChart") speedChartRef!: ElementRef;
  @ViewChild("progressChart") progressChartRef!: ElementRef;

  dataSource = new MatTableDataSource<TransferFile>([]);
  displayedColumns: string[] = ["name", "percentage", "speed", "size", "eta"];

  stats: GlobalStats = this.getDefaultStats();
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
    private rcloneService: RcloneService,
    public iconService: IconService,
    private ngZone: NgZone,
    private cdr: ChangeDetectorRef
  ) {
    Chart.register(...registerables);
  }

  ngOnInit(): void {
    this.setupRemoteSettingsSections();
  }

  ngAfterViewInit(): void {
    this.initCharts();
    this.dataSource.sort = this.sort;
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

  // Public methods
  toggleDryRun(): void {
    this.dryRun = !this.dryRun;
  }

  triggerOpenInFiles(path: string): void {
    if (this.selectedRemote?.remoteSpecs?.name) {
      this.openInFiles.emit({
        remoteName: this.selectedRemote.remoteSpecs.name,
        path,
      });
    }
  }

  async toggleOperation(): Promise<void> {
    if (!this.selectedRemote) return;

    this.isLoading = true;
    try {
      const isOperationActive = this.isOperationActive();
      const remoteName = this.selectedRemote.remoteSpecs?.name || "";

      if (isOperationActive) {
        await this.stopOperation.emit({
          type: this.operationType,
          remoteName,
        });
      } else {
        await this.startOperation.emit({
          type: this.operationType,
          remoteName,
        });
        this.currentJobId = this.getCurrentJobId();
        this.lastSyncTime = new Date().toLocaleString();
      }
      this.errorMessage = "";
    } catch (error) {
      this.handleSyncError(error);
    } finally {
      this.isLoading = false;
      this.cdr.markForCheck();
    }
  }

  triggerOpenRemoteConfig(editTarget?: string, existingConfig?: any): void {
    this.openRemoteConfigModal.emit({ editTarget, existingConfig });
  }

  // Getters
  get transferSummary(): { total: number; completed: number; active: number } {
    return {
      total: this.stats.totalTransfers || 0,
      completed: (this.stats.totalTransfers || 0) - (this.stats.transfers || 0),
      active: this.stats.transferring?.length || 0,
    };
  }

  get errorSummary(): string {
    if (this.stats.fatalError) {
      return this.stats.lastError || "Fatal error occurred";
    }
    if (this.stats.errors > 0) {
      return `${this.stats.errors} error(s) occurred`;
    }
    return "";
  }

  get operationDestination(): string {
    return (
      (this.remoteSettings?.[`${this.operationType}Config`]?.[
        "dest"
      ] as string) || "Need to set!"
    );
  }

  get operationColor(): ThemePalette {
    return this.operationType === "sync" ? "primary" : "accent";
  }

  get operationClass(): string {
    return `${this.operationType}-operation`;
  }

  get operationSource(): string {
    return (
      (this.remoteSettings?.[`${this.operationType}Config`]?.[
        "source"
      ] as string) || "Need to set!"
    );
  }

  // Utility methods
  isLocalPath(path: string): boolean {
    if (!path) return false;
    return (
      /^[a-zA-Z]:[\\/]/.test(path) ||
      path.startsWith("/") ||
      path.startsWith("~/") ||
      path.startsWith("./")
    );
  }

  getFormattedSpeed(): string {
    const { value, unit } = this.getSpeedUnitAndValue(this.stats.speed);
    return `${value.toFixed(2)} ${unit}`;
  }

  isSensitiveKey(key: string): boolean {
    return (
      SENSITIVE_KEYS.some((sensitive) =>
        key.toLowerCase().includes(sensitive)
      ) && this.restrictMode
    );
  }

  maskSensitiveValue(key: string, value: any): string {
    return this.isSensitiveKey(key)
      ? "RESTRICTED"
      : this.truncateValue(value, 15);
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

  // Private methods
  private isOperationActive(): boolean {
    return this.operationType === "sync"
      ? !!this.selectedRemote?.syncState?.isOnSync
      : !!this.selectedRemote?.copyState?.isOnCopy;
  }

  private getCurrentJobId(): number | undefined {
    return this.operationType === "sync"
      ? this.selectedRemote?.syncState?.syncJobID
      : this.selectedRemote?.copyState?.copyJobID;
  }

  private setupRemoteSettingsSections(): void {
    this.remoteSettingsSections = [
      {
        key: this.operationType,
        title: `${this.operationType
          .charAt(0)
          .toUpperCase()}${this.operationType.slice(1)} Options`,
        icon: this.operationType,
      },
      { key: "filter", title: "Filter Options", icon: "filter" },
    ];
  }

  private getDefaultStats(): GlobalStats {
    return {
      bytes: 0,
      checks: 0,
      deletedDirs: 0,
      deletes: 0,
      elapsedTime: 0,
      errors: 0,
      eta: 0,
      fatalError: false,
      lastError: "",
      renames: 0,
      retryError: false,
      serverSideCopies: 0,
      serverSideCopyBytes: 0,
      serverSideMoveBytes: 0,
      serverSideMoves: 0,
      speed: 0,
      totalBytes: 0,
      totalChecks: 0,
      totalTransfers: 0,
      transferTime: 0,
      transferring: [],
      transfers: 0,
    };
  }

  private handleSelectedRemoteChange(): void {
    this.stats = this.getDefaultStats();
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
      "Transfer Speed",
      "#4285F4",
      "Speed (B/s)"
    );

    this.progressChart = this.createChart(
      this.progressChartRef.nativeElement,
      "Overall Progress",
      "#34A853",
      "Progress (%)",
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
      type: "line",
      data: {
        labels: Array(this.MAX_HISTORY_LENGTH).fill(""),
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
    this.updateSpeedChart();
    this.updateProgressChart();
  }

  private updateSpeedChart(): void {
    const speedData = this.getSpeedUnitAndValue(this.stats.speed);
    const speedInSelectedUnit = speedData.value;

    this.speedHistory.push(speedInSelectedUnit);
    if (this.speedHistory.length > this.MAX_HISTORY_LENGTH) {
      this.speedHistory.shift();
    }

    this.speedChart.data.datasets[0].data = [...this.speedHistory];

    const yScale = this.speedChart.options.scales?.["y"] as any;
    if (yScale?.title) {
      yScale.title.text = `Speed (${speedData.unit})`;
    }

    this.speedChart.update();
  }

  private updateProgressChart(): void {
    const progress = this.calculateProgress();

    this.progressHistory.push(progress);
    if (this.progressHistory.length > this.MAX_HISTORY_LENGTH) {
      this.progressHistory.shift();
    }

    this.progressChart.data.datasets[0].data = [...this.progressHistory];
    this.progressChart.update();
  }

  private calculateProgress(): number {
    // Use file-specific total bytes if available
    const totalBytes =
      this.stats.totalBytes ||
      this.dataSource.data.reduce((sum, f) => sum + (f.size || 0), 0);

    return totalBytes > 0
      ? Math.min(100, (this.stats.bytes / totalBytes) * 100)
      : 0;
  }

  private getSpeedUnitAndValue(speedInBps: number): {
    value: number;
    unit: string;
  } {
    const units = ["B/s", "KB/s", "MB/s", "GB/s"];
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
    this.rcloneService
      .getJobStatus(this.currentJobId!)
      .then((job) => {
        if (job) {
          this.ngZone.run(() => this.updateStatsFromJob(job));
        }
      })
      .catch((error) => console.error("Error fetching job status:", error));
  }

  private updateStatsFromJob(job: any): void {
    if (!job.stats) return;

    const transferringFiles = this.processTransferringFiles(
      job.stats.transferring
    );
    const fileStats = this.getAggregatedStatsFromFiles(transferringFiles);

    // Combine global stats with file-specific stats
    const updatedStats = {
      ...job.stats,
      transferring: transferringFiles,
      // Override some stats with file-specific calculations
      speed: fileStats.totalSpeed,
      eta: fileStats.totalEta,
      bytes: fileStats.totalBytes,
      totalBytes: fileStats.totalSize,
      transfers: fileStats.activeFiles,
    };

    this.stats = updatedStats;
    this.updateRemoteStatusOnError(job);
    this.updateChartData();
    this.dataSource.data = transferringFiles;
    this.cdr.markForCheck();
  }

  private processTransferringFiles(files: any[] = []): TransferFile[] {
    return (files as TransferFile[]).map((file) => ({
      ...file,
      percentage:
        file.size > 0
          ? Math.min(100, Math.round((file.bytes / file.size) * 100))
          : 0,
      isError: file.percentage === 100 && file.bytes < file.size,
    }));
  }

  private updateRemoteStatusOnError(job: any): void {
    if (job.stats.fatalError && this.selectedRemote) {
      const stateKey =
        this.operationType === "sync" ? "syncState" : "copyState";

      this.selectedRemote = {
        ...this.selectedRemote,
        [stateKey]: {
          isOnSync: "error",
        },
      };
    }
  }

  private resetHistory(): void {
    this.progressHistory = [];
    this.speedHistory = [];
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
  }

  private destroyCharts(): void {
    this.speedChart?.destroy();
    this.progressChart?.destroy();
  }

  private truncateValue(value: any, length: number): string {
    if (value == null) return "";

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

  private handleSyncError(error: any): void {
    this.errorMessage =
      error instanceof Error ? error.message : "Failed to toggle sync";
  }

  private getAggregatedStatsFromFiles(files: TransferFile[]) {
    if (!files || files.length === 0) {
      return {
        totalSpeed: 0,
        avgSpeed: 0,
        totalBytes: 0,
        totalSize: 0,
        totalEta: 0,
        activeFiles: 0,
      };
    }

    // Calculate from transferring files
    const activeFiles = files.filter((f) => f.percentage < 100);
    const totalSpeed = activeFiles.reduce((sum, f) => sum + (f.speed || 0), 0);
    const avgSpeed =
      activeFiles.length > 0 ? totalSpeed / activeFiles.length : 0;
    const totalBytes = files.reduce((sum, f) => sum + (f.bytes || 0), 0);
    const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);

    // Calculate ETA based on remaining bytes and current speed
    const remainingBytes = totalSize - totalBytes;
    const calculatedEta = totalSpeed > 0 ? remainingBytes / totalSpeed : 0;

    return {
      totalSpeed,
      avgSpeed,
      totalBytes,
      totalSize,
      totalEta: calculatedEta,
      activeFiles: activeFiles.length,
    };
  }
}
