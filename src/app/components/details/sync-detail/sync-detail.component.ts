import { CommonModule } from "@angular/common";
import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnDestroy,
  Output,
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

// Pipes
@Pipe({ name: "filesize", standalone: true })
export class FileSizePipe implements PipeTransform {
  transform(bytes: number = 0, precision: number = 2): string {
    if (isNaN(parseFloat(String(bytes))) || !isFinite(bytes)) return "0 B";

    const units = ["B", "KB", "MB", "GB", "TB"];
    let unitIndex = 0;

    while (bytes >= 1024 && unitIndex < units.length - 1) {
      bytes /= 1024;
      unitIndex++;
    }

    return `${bytes.toFixed(precision)} ${units[unitIndex]}`;
  }
}

@Pipe({ name: "formatTime", standalone: true })
export class FormatTimePipe implements PipeTransform {
  transform(seconds: number): string {
    if (isNaN(seconds)) return "";

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    }
    return `${secs}s`;
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
    MatSlideToggleModule
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

  @ViewChild("speedChart") speedChartRef!: ElementRef;
  @ViewChild("progressChart") progressChartRef!: ElementRef;

  isSyncing = true;
  lastSyncTime = new Date();

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

  // Mock data
  stats: SyncStats = {
    bytes: 41664894,
    checks: 32,
    deletedDirs: 0,
    deletes: 0,
    elapsedTime: 909.680364148,
    errors: 12,
    eta: 14628,
    fatalError: false,
    lastError: "multi-thread copy: failed to write chunk: context canceled",
    renames: 0,
    retryError: true,
    serverSideCopies: 0,
    serverSideCopyBytes: 0,
    serverSideMoveBytes: 0,
    serverSideMoves: 0,
    speed: 841728.3913165091,
    totalBytes: 12354661185,
    totalChecks: 32,
    totalTransfers: 8,
    transferTime: 25.96935682,
    transferring: [
      {
        bytes: 3014656,
        dstFs: "/home/user/Documents/Google",
        eta: 1222,
        group: "job/5",
        name: "MEZUNIYET.zip",
        percentage: 0,
        size: 463656164,
        speed: 485648.93327225564,
        speedAvg: 376831.9693976102,
        srcFs: "Google Drive:",
      },
      {
        bytes: 126976,
        dstFs: "/home/user/Documents/Google",
        eta: 161,
        group: "job/5",
        name: "University/Project.pdf",
        percentage: 1,
        size: 6968381,
        speed: 38458.51027742036,
        speedAvg: 42324.83408845396,
        srcFs: "Google Drive:",
      },
      {
        bytes: 3014656,
        dstFs: "/home/user/Documents/Google",
        eta: 758,
        group: "job/5",
        name: "University/Presentation.mp4",
        percentage: 0,
        size: 329761503,
        speed: 483429.0395659025,
        speedAvg: 430665.35153259535,
        srcFs: "Google Drive:",
      },
      {
        bytes: 3014656,
        dstFs: "/home/user/Documents/Google",
        eta: 758,
        group: "job/5",
        name: "University/Presentation.mp4",
        percentage: 0,
        size: 329761503,
        speed: 483429.0395659025,
        speedAvg: 430665.35153259535,
        srcFs: "Google Drive:",
      },
      {
        bytes: 3014656,
        dstFs: "/home/user/Documents/Google",
        eta: 758,
        group: "job/5",
        name: "University/Presentation.mp4",
        percentage: 0,
        size: 329761503,
        speed: 483429.0395659025,
        speedAvg: 430665.35153259535,
        srcFs: "Google Drive:",
      },
      {
        bytes: 3014656,
        dstFs: "/home/user/Documents/Google",
        eta: 758,
        group: "job/5",
        name: "University/Presentation.mp4",
        percentage: 0,
        size: 329761503,
        speed: 483429.0395659025,
        speedAvg: 430665.35153259535,
        srcFs: "Google Drive:",
      },
      {
        bytes: 3014656,
        dstFs: "/home/user/Documents/Google",
        eta: 758,
        group: "job/5",
        name: "University/Presentation.mp4",
        percentage: 0,
        size: 329761503,
        speed: 483429.0395659025,
        speedAvg: 430665.35153259535,
        srcFs: "Google Drive:",
      },
      {
        bytes: 3014656,
        dstFs: "/home/user/Documents/Google",
        eta: 758,
        group: "job/5",
        name: "University/Presentation.mp4",
        percentage: 0,
        size: 329761503,
        speed: 483429.0395659025,
        speedAvg: 430665.35153259535,
        srcFs: "Google Drive:",
      },
      {
        bytes: 3014656,
        dstFs: "/home/user/Documents/Google",
        eta: 758,
        group: "job/5",
        name: "University/Presentation.mp4",
        percentage: 0,
        size: 329761503,
        speed: 483429.0395659025,
        speedAvg: 430665.35153259535,
        srcFs: "Google Drive:",
      },
      {
        bytes: 3014656,
        dstFs: "/home/user/Documents/Google",
        eta: 758,
        group: "job/5",
        name: "University/Presentation.mp4",
        percentage: 0,
        size: 329761503,
        speed: 483429.0395659025,
        speedAvg: 430665.35153259535,
        srcFs: "Google Drive:",
      },
      {
        bytes: 3014656,
        dstFs: "/home/user/Documents/Google",
        eta: 758,
        group: "job/5",
        name: "University/Presentation.mp4",
        percentage: 0,
        size: 329761503,
        speed: 483429.0395659025,
        speedAvg: 430665.35153259535,
        srcFs: "Google Drive:",
      },
      {
        bytes: 3014656,
        dstFs: "/home/user/Documents/Google",
        eta: 758,
        group: "job/5",
        name: "University/Presentation.mp4",
        percentage: 0,
        size: 329761503,
        speed: 483429.0395659025,
        speedAvg: 430665.35153259535,
        srcFs: "Google Drive:",
      },
      {
        bytes: 262144,
        dstFs: "/home/user/Documents/Google",
        eta: 11,
        group: "job/5",
        name: "University/Thesis.docx",
        percentage: 28,
        size: 922016,
        speed: 52511.59117144923,
        speedAvg: 57343.118438488455,
        srcFs: "Google Drive:",
      },
    ],
    transfers: 4,
  };

  constructor(public iconService: IconService) {
    Chart.register(...registerables);
  }

  ngAfterViewInit(): void {
    this.initCharts();
    this.simulateLiveData();
  }

  ngOnDestroy(): void {
    this.cleanUp();
  }

  toggleSync(): void {
    this.isSyncing = !this.isSyncing;
    if (this.isSyncing) {
      this.simulateLiveData();
    } else {
      this.clearDataInterval();
    }
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

  private initCharts(): void {
    this.speedChart = this.createChart(
      this.speedChartRef.nativeElement,
      "Transfer Speed",
      "#4285F4",
      "Speed (bytes/s)"
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

  private simulateLiveData(): void {
    this.clearDataInterval();
    this.updateChartData();

    this.dataInterval = setInterval(() => {
      if (!this.isSyncing) return;

      this.updateStats();
      this.updateChartData();
    }, 1000);
  }

  private updateStats(): void {
    // Update speed with random fluctuation
    this.stats.speed = this.stats.speed * (0.9 + Math.random() * 0.2);

    // Update transferred bytes
    this.stats.bytes = Math.min(
      this.stats.totalBytes,
      this.stats.bytes + this.stats.speed
    );

    // Update transferring files
    this.stats.transferring.forEach((file) => {
      if (file.percentage < 100) {
        file.bytes = Math.min(
          file.size,
          file.bytes + file.speed * (0.8 + Math.random() * 0.4)
        );
        file.percentage = Math.round((file.bytes / file.size) * 100);
        file.speed = file.speed * (0.9 + Math.random() * 0.2);
      }
    });

    // Update ETA
    if (this.stats.speed > 0) {
      this.stats.eta =
        (this.stats.totalBytes - this.stats.bytes) / this.stats.speed;
    }
  }

  private updateChartData(): void {
    // Update speed chart
    this.speedHistory.push(this.stats.speed);
    if (this.speedHistory.length > 30) this.speedHistory.shift();
    this.speedChart.data.datasets[0].data = [...this.speedHistory];
    this.speedChart.update();

    // Update progress chart
    const progress = (this.stats.bytes / this.stats.totalBytes) * 100;
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
