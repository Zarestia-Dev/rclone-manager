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
} from "@angular/core";
import { MatIconModule } from "@angular/material/icon";
import { MatTooltipModule } from "@angular/material/tooltip";
import { Chart, registerables } from "chart.js";
import { Pipe, PipeTransform } from "@angular/core";
import { MatDividerModule } from "@angular/material/divider";
import { MatCardModule } from "@angular/material/card";
import { MatChipsModule } from "@angular/material/chips";
import { SENSITIVE_KEYS } from "../../../shared/remote-config-types";
import { MatButtonModule } from "@angular/material/button";
import { MatTabsModule } from "@angular/material/tabs";
import { IconService } from "../../../services/icon.service";
import { MatSlideToggleModule } from "@angular/material/slide-toggle";
import { map, Observable, Subscription } from "rxjs";
import { RcloneService } from "../../../services/rclone.service";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";

// Interfaces
interface RemoteDiskUsage {
  total_space?: string;
  used_space?: string;
  free_space?: string;
}

interface RemoteSpecs {
  name: string;
  type: string;
  [key: string]: any;
}

interface RemoteSettings {
  [key: string]: { [key: string]: any };
}

interface Remote {
  custom_flags?: { [key: string]: any };
  mount_options?: { [key: string]: any };
  name?: string;
  showOnTray?: boolean;
  type?: string;
  remoteSpecs?: RemoteSpecs;
  diskUsage?: RemoteDiskUsage;
  syncJobID?: number;
  isOnSync?: boolean | "error";

  mounted?: boolean | string;
}

interface RemoteSettingsSection {
  key: string;
  title: string;
  icon: string;
}

interface TransferFile {
  bytes: number;
  dstFs: string;
  eta: number;
  group: string;
  name: string;
  percentage: number;
  size: number;
  speed: number;
  speedAvg: number;
  srcFs: string;
}

interface ActiveJob {
  jobid: number;
  job_type: string;
  source: string;
  destination: string;
  start_time: string;
  status: string;
  remote_name: string;
  stats: any;
}

interface SyncStats {
  bytes: number;
  checks: number;
  deletedDirs: number;
  deletes: number;
  elapsedTime: number;
  errors: number;
  eta: number;
  fatalError: boolean;
  lastError: string;
  renames: number;
  retryError: boolean;
  serverSideCopies: number;
  serverSideCopyBytes: number;
  serverSideMoveBytes: number;
  serverSideMoves: number;
  speed: number;
  totalBytes: number;
  totalChecks: number;
  totalTransfers: number;
  transferTime: number;
  transferring: TransferFile[];
  transfers: number;
}

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
    if (isNaN(parseFloat(String(bytes))) || !isFinite(bytes))
      return mode === "speed" ? "0 B/s" : "0 B";

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
  selector: "app-sync-detail",
  standalone: true,
  imports: [
    CommonModule,
    MatIconModule,
    MatTooltipModule,
    FileSizePipe,
    FormatTimePipe,
    MatDividerModule,
    MatCardModule,
    MatChipsModule,
    MatButtonModule,
    MatTabsModule,
    MatSlideToggleModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: "./sync-detail.component.html",
  styleUrls: ["./sync-detail.component.scss"],
})
export class SyncDetailComponent implements AfterViewInit, OnDestroy {
  @Input() selectedRemote: Remote | null = null;
  @Input() remoteSettings: RemoteSettings = {};
  @Output() openRemoteConfigModal = new EventEmitter<{
    editTarget?: string;
    existingConfig?: any;
  }>();

  @Output() openInFiles = new EventEmitter<string>();
  @Output() startSync = new EventEmitter<string>();
  @Output() stopSync = new EventEmitter<string>();

  stats: SyncStats = {
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

  @ViewChild("speedChart") speedChartRef!: ElementRef;
  @ViewChild("progressChart") progressChartRef!: ElementRef;

  // isSyncing = false;
  lastSyncTime = new Date();
  dryRun = false;

  // Charts
  private speedChart!: Chart;
  private progressChart!: Chart;
  private dataInterval?: any;
  private speedHistory: number[] = [];
  private progressHistory: number[] = [];

  // Settings
  readonly remoteSettingsSections: RemoteSettingsSection[] = [
    { key: "sync", title: "Sync Options", icon: "sync" },
    { key: "filter", title: "Filter Options", icon: "filter" },
  ];

  constructor(
    private rcloneService: RcloneService,
    public iconService: IconService,
    private ngZone: NgZone,
    private cdr: ChangeDetectorRef
  ) {
    Chart.register(...registerables);
  }

  ngAfterViewInit(): void {
    this.initCharts();
    this.simulateLiveData();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes["selectedRemote"] && this.selectedRemote) {
      // Always update currentJobId when selectedRemote changes
      this.currentJobId = this.selectedRemote.syncJobID;
      this.resetHistory();
      this.cdr.markForCheck();
    }
  }

  toggleDryRun(): void {
    this.dryRun = !this.dryRun;
  }

  getStatsForJob(jobid: number): Observable<SyncStats | null> {
    return this.rcloneService.activeJobs$.pipe(
      map((jobs) => {
        const job = jobs.find((j) => j.jobid === jobid);
        return job ? job.stats : null;
      })
    );
  }

  private jobSubscription?: Subscription;
  currentJobId?: number;

  async ngOnInit(): Promise<void> {
    // Initialize with current job ID if sync is active
    if (this.selectedRemote?.isOnSync) {
      this.currentJobId = this.selectedRemote.syncJobID;
    }

    // Subscribe to active jobs updates
    this.jobSubscription = this.rcloneService.activeJobs$.subscribe((jobs) => {
      if (!this.selectedRemote) return;

      const job = jobs.find(
        (j) =>
          j.remote_name === this.selectedRemote?.remoteSpecs?.name &&
          j.status === "running"
      );

      if (job) {
        this.currentJobId = job.jobid;
        this.updateStatsFromJob(job);
      }
    });
  }

  ngOnDestroy(): void {
    this.jobSubscription?.unsubscribe();
    this.cleanUp();
  }

  get transferSummary(): { total: number; completed: number; active: number } {
    return {
      total: this.stats.totalTransfers || 0,
      completed: (this.stats.totalTransfers || 0) - (this.stats.transfers || 0),
      active: this.stats.transferring?.length || 0,
    };
  }

  get hasErrors(): boolean {
    return this.stats.errors > 0 || this.stats.fatalError;
  }

  get errorSummary(): string {
    if (this.stats.fatalError)
      return this.stats.lastError || "Fatal error occurred";
    if (this.stats.errors > 0) return `${this.stats.errors} error(s) occurred`;
    return "";
  }

  async toggleSync(): Promise<void> {
    if (!this.selectedRemote) return;

    this.isLoading = true;
    try {
      if (this.selectedRemote.isOnSync) {
        await this.stopSync.emit(this.selectedRemote.remoteSpecs?.name || "");
      } else {
        await this.startSync.emit(this.selectedRemote.remoteSpecs?.name || "");
        // Set currentJobId after starting sync
        this.currentJobId = this.selectedRemote.syncJobID;
      }
    } catch (error) {
      this.errorMessage =
        error instanceof Error ? error.message : "Failed to toggle sync";
    } finally {
      this.isLoading = false;
      this.cdr.markForCheck();
    }
  }

  isLoading = false;
  errorMessage = "";
  private updateStatsFromJob(job: ActiveJob): void {
    this.ngZone.run(() => {
      if (job.stats) {
        const updatedStats = {
          ...job.stats,
          transferring:
            job.stats.transferring?.map(
              (file: { size: number; bytes: number }) => ({
                ...file,
                percentage:
                  file.size > 0
                    ? Math.min(100, Math.round((file.bytes / file.size) * 100))
                    : 0,
              })
            ) || [],
        };

        this.stats = updatedStats;

        if (job.stats.fatalError) {
          this.selectedRemote = {
            ...this.selectedRemote,
            isOnSync: "error",
          };
        }
        this.updateChartData();
        this.cdr.markForCheck();
      }
    });
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

    return {
      value: speed,
      unit: units[unitIndex],
    };
  }

  private simulateLiveData(): void {
    this.clearDataInterval();

    this.dataInterval = setInterval(() => {
      if (!this.selectedRemote?.isOnSync || !this.currentJobId) {
        console.log("No active sync or missing job ID");
        return;
      }

      this.rcloneService
        .getJobStatus(this.currentJobId)
        .then((job) => {
          if (!job) {
            console.warn("No job data received for ID:", this.currentJobId);
            return;
          }
          this.ngZone.run(() => {
            console.log("Job data received:", job);
            this.updateStatsFromJob(job);
            console.log("Job stats updated:", job.stats);
          });
        })
        .catch((error) => {
          console.error("Error fetching job status:", error);
        });
    }, 1000);
  }

  triggerOpenRemoteConfig(editTarget?: string, existingConfig?: any): void {
    this.openRemoteConfigModal.emit({ editTarget, existingConfig });
  }

  isSensitiveKey(key: string): boolean {
    return SENSITIVE_KEYS.some((sensitive) =>
      key.toLowerCase().includes(sensitive)
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
  private resetHistory(): void {
    this.progressHistory = [];
    this.speedHistory = [];
  }

  getFormattedSpeed(): string {
    const { value, unit } = this.getSpeedUnitAndValue(this.stats.speed);
    return `${value.toFixed(2)} ${unit}`;
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
        labels: Array(30).fill(""),
        datasets: [
          {
            label,
            data: Array(30).fill(0),
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

  isObjectButNotArray(value: any): boolean {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  private updateChartData(): void {
    const speedData = this.getSpeedUnitAndValue(this.stats.speed);
    const speedInSelectedUnit = speedData.value;

    this.speedHistory.push(speedInSelectedUnit);
    if (this.speedHistory.length > 30) this.speedHistory.shift();

    this.speedChart.data.datasets[0].data = [...this.speedHistory];

    const yScale = this.speedChart.options.scales?.["y"] as any;
    if (yScale?.title) {
      yScale.title.text = `Speed (${speedData.unit})`;
    }

    this.speedChart.update();

    const progress =
      this.stats.totalBytes > 0
        ? Math.min(100, (this.stats.bytes / this.stats.totalBytes) * 100)
        : 0;

    this.progressHistory.push(progress);
    if (this.progressHistory.length > 30) this.progressHistory.shift();
    this.progressChart.data.datasets[0].data = [...this.progressHistory];
    this.progressChart.update();
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

  private clearDataInterval(): void {
    if (this.dataInterval) {
      clearInterval(this.dataInterval);
      this.dataInterval = undefined;
    }
  }

  private cleanUp(): void {
    this.clearDataInterval();
    this.speedChart?.destroy();
    this.progressChart?.destroy();
  }

  get syncDestination(): string {
    return this.remoteSettings?.["syncConfig"]?.["dest"] || "Need to set!";
  }

  get syncSource(): string {
    return (
      this.selectedRemote?.remoteSpecs?.name +
      ":/" +
      (this.remoteSettings?.["syncConfig"]?.["source"] || "")
    );
  }
}
