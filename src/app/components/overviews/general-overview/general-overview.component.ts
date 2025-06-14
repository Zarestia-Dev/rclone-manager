import {
  Component,
  EventEmitter,
  Output,
  OnInit,
  OnDestroy,
  ChangeDetectorRef,
  Input,
  HostListener,
} from "@angular/core";
import { CommonModule } from "@angular/common";
import { MatCardModule } from "@angular/material/card";
import { MatIconModule } from "@angular/material/icon";
import { MatButtonModule } from "@angular/material/button";
import { MatTooltipModule } from "@angular/material/tooltip";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { MatExpansionModule } from "@angular/material/expansion";
import { trigger, transition, style, animate } from "@angular/animations";
import { Subject, interval, of, from } from "rxjs";
import { takeUntil, catchError, switchMap, finalize } from "rxjs/operators";

import { RcloneService } from "../../../services/rclone.service";
import { InfoService } from "../../../services/info.service";
import {
  BandwidthLimitResponse,
  MemoryStats,
  GlobalStats,
  JobInfo,
  Remote,
} from "../../../shared/components/types";

interface SystemStats {
  memoryUsage: string;
  uptime: string;
}

const DEFAULT_JOB_STATS: GlobalStats = {
  bytes: 0,
  totalBytes: 0,
  speed: 0,
  eta: 0,
  totalTransfers: 0,
  transfers: 0,
  errors: 0,
  checks: 0,
  totalChecks: 0,
  deletedDirs: 0,
  deletes: 0,
  renames: 0,
  serverSideCopies: 0,
  serverSideMoves: 0,
  elapsedTime: 0,
  lastError: "",
  fatalError: false,
  retryError: false,
  serverSideCopyBytes: 0,
  serverSideMoveBytes: 0,
  transferTime: 0,
  transferring: [],
};

const ANIMATIONS = [
  trigger("fadeInOut", [
    transition(":enter", [
      style({ opacity: 0, transform: "translateY(10px)" }),
      animate(
        "300ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
        style({ opacity: 1, transform: "translateY(0)" })
      ),
    ]),
    transition(":leave", [
      animate(
        "200ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
        style({ opacity: 0, transform: "translateY(-10px)" })
      ),
    ]),
  ]),
];

@Component({
  selector: "app-general-overview",
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    MatExpansionModule,
    MatProgressBarModule,
  ],
  templateUrl: "./general-overview.component.html",
  styleUrls: ["./general-overview.component.scss"],
  animations: ANIMATIONS,
})
export class GeneralOverviewComponent implements OnInit, OnDestroy {
  @Input() remotes: Remote[] = [];
  @Input() jobs: JobInfo[] = [];
  @Input() iconService: any;

  @Output() selectRemote = new EventEmitter<Remote>();
  @Output() mountRemote = new EventEmitter<string>();
  @Output() unmountRemote = new EventEmitter<string>();
  @Output() syncRemote = new EventEmitter<string>();
  @Output() copyRemote = new EventEmitter<string>();
  @Output() stopJob = new EventEmitter<{
    type: "sync" | "copy";
    remoteName: string;
  }>();
  @Output() browseRemote = new EventEmitter<string>();

  bandwidthLimit: BandwidthLimitResponse | null = null;
  isLoadingBandwidth = false;
  bandwidthError: string | null = null;
  rcloneStatus: "active" | "inactive" | "error" = "inactive";

  // Panel states
  bandwidthPanelOpenState = false;
  systemInfoPanelOpenState = false;
  jobInfoPanelOpenState = false;

  systemStats: SystemStats = {
    memoryUsage: "0 MB",
    uptime: "0s",
  };

  isLoadingStats = false;
  jobStats: GlobalStats = { ...DEFAULT_JOB_STATS };

  private destroy$ = new Subject<void>();
  hoveredRemote: Remote | null = null;

  constructor(
    private rcloneService: RcloneService,
    private cdr: ChangeDetectorRef,
    private infoService: InfoService
  ) {}

  ngOnInit(): void {
    this.initializeComponent();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private initializeComponent(): void {
    this.loadInitialData();
    this.setupPolling();
    this.setupEventListeners();
  }

  private loadInitialData(): void {
    this.loadBandwidthLimit();
    this.loadSystemStats();
    this.checkRcloneStatus();
  }

  private setupPolling(): void {
    interval(1000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.loadSystemStats());
  }

  private setupEventListeners(): void {
    this.listenToBandwidthChanges();
    this.listenToRcloneStatusChanges();
  }

  private checkRcloneStatus(): void {
    this.rcloneService
      .getRcloneInfo()
      .then((status) => {
        this.rcloneStatus = status ? "active" : "inactive";
        this.cdr.markForCheck();
      })
      .catch(() => {
        this.rcloneStatus = "error";
        this.cdr.markForCheck();
      });
  }

  private listenToBandwidthChanges(): void {
    this.rcloneService
      .listenToBandwidthChanges()
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.loadBandwidthLimit());
  }

  private listenToRcloneStatusChanges(): void {
    const status$ = this.rcloneService.listenToRcloneApiReady();
    const error$ = this.rcloneService.listenToRcloneEngineFailed();
    const invalidPath$ = this.rcloneService.listenToRclonePathInvalid();

    status$.pipe(takeUntil(this.destroy$)).subscribe(() => {
      this.rcloneStatus = "active";
      this.cdr.markForCheck();
    });

    error$.pipe(takeUntil(this.destroy$)).subscribe(() => {
      this.rcloneStatus = "error";
      this.cdr.markForCheck();
    });

    invalidPath$.pipe(takeUntil(this.destroy$)).subscribe(() => {
      this.rcloneStatus = "error";
      this.cdr.markForCheck();
    });
  }

  loadBandwidthLimit(): void {
    if (this.isLoadingBandwidth) return;

    this.isLoadingBandwidth = true;
    this.bandwidthError = null;

    from(this.rcloneService.getBandwidthLimit())
      .pipe(
        catchError((error) => {
          this.bandwidthError = "Failed to load bandwidth limit";
          if (!this.bandwidthLimit) {
            setTimeout(() => this.loadBandwidthLimit(), 5000);
          }
          return of(null);
        }),
        finalize(() => {
          this.isLoadingBandwidth = false;
          this.cdr.markForCheck();
        })
      )
      .subscribe((response) => {
        this.bandwidthLimit = response;
      });
  }

  async loadSystemStats(): Promise<void> {
    if (this.isLoadingStats) return;

    this.isLoadingStats = true;

    try {
      const [memoryStats, coreStats] = await Promise.all([
        this.rcloneService.getMemoryStats().catch(() => null),
        this.rcloneService.getCoreStats().catch(() => null),
      ]);

      this.updateSystemStats(memoryStats, coreStats);
    } catch {
      this.rcloneStatus = "error";
    } finally {
      this.isLoadingStats = false;
      this.cdr.markForCheck();
    }
  }

  private updateSystemStats(
    memoryStats: MemoryStats | null,
    coreStats: GlobalStats | null
  ): void {
    this.systemStats = {
      memoryUsage: this.formatMemoryUsage(memoryStats),
      uptime: this.formatUptime(coreStats?.elapsedTime || 0),
    };

    this.jobStats = coreStats
      ? { ...DEFAULT_JOB_STATS, ...coreStats }
      : { ...DEFAULT_JOB_STATS };
  }

  // Formatting utilities
  formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";

    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  private formatMemoryUsage(memoryStats: MemoryStats | null): string {
    return memoryStats?.HeapAlloc
      ? `${Math.round(memoryStats.HeapAlloc / 1024 / 1024)} MB`
      : "Unknown";
  }

  formatUptime(elapsedTimeSeconds: number): string {
    if (!elapsedTimeSeconds) return "0s";

    const totalSeconds = Math.floor(elapsedTimeSeconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return hours > 0
      ? `${hours}h ${minutes}m`
      : minutes > 0
      ? `${minutes}m ${seconds}s`
      : `${seconds}s`;
  }

  formatEta(eta: number | string): string {
    if (!eta) return "0s";
    if (typeof eta === "number") return `${Math.max(eta, 0)}s`;

    const match = eta.match(/(?:(\d+)m)?(?:(\d+)s)?/);
    return match
      ? `${parseInt(match[1] || "0") * 60 + parseInt(match[2] || "0")}s`
      : eta;
  }

  // Computed properties
  get totalRemotes(): number {
    return this.remotes?.length || 0;
  }

  get activeJobsCount(): number {
    return this.jobs?.filter((job) => job.status === "Running").length || 0;
  }

  get jobCompletionPercentage(): number {
    const totalBytes = this.jobStats.totalBytes || 0;
    const bytes = this.jobStats.bytes || 0;
    return totalBytes > 0 ? Math.min(100, (bytes / totalBytes) * 100) : 0;
  }

  get isBandwidthLimited(): boolean {
    const limit = this.bandwidthLimit;
    return (
      !!limit &&
      limit.rate !== "off" &&
      limit.rate !== "" &&
      limit.bytesPerSecond !== -1
    );
  }

  get formattedBandwidthRate(): string {
    if (!this.isBandwidthLimited) return "Unlimited";

    return this.bandwidthLimit!.rate.includes(":")
      ? this.bandwidthLimit!.rate.split(":")
          .map((r, i) => `${i === 0 ? "↑" : "↓"}${this.formatRateValue(r)}`)
          .join(" ")
      : this.formatRateValue(this.bandwidthLimit!.rate);
  }

  get bandwidthDisplayValue(): string {
    if (this.bandwidthError) return "Error loading limit";
    if (!this.isBandwidthLimited) return "Unlimited";

    const rate = this.formattedBandwidthRate;
    return rate.includes("↑") && rate.includes("↓")
      ? rate
      : `Limited to ${rate}`;
  }

  private formatRateValue(rate: string): string {
    if (!rate || rate === "off") return "Unlimited";

    const units = { Ki: "KB/s", Mi: "MB/s", Gi: "GB/s", Ti: "TB/s" };
    const unit = Object.keys(units).find((u) => rate.endsWith(u));

    if (unit) {
      return `${rate.replace(unit, "")} ${units[unit as keyof typeof units]}`;
    }

    const numValue = parseInt(rate);
    return isNaN(numValue) ? rate : this.formatBytesPerSecond(numValue);
  }

  private formatBytesPerSecond(bytes: number): string {
    if (bytes <= 0) return "Unlimited";

    const units = ["B/s", "KB/s", "MB/s", "GB/s", "TB/s"];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
  }

  get systemStatusColor(): string {
    return `status-${this.rcloneStatus}`;
  }

  // Event handlers
  onQuickAction(event: Event, remoteName: string, action: string): void {
    event.stopPropagation(); // Prevent card click

    switch (action) {
      case "mount":
        this.mountRemote.emit(remoteName);
        break;
      case "unmount":
        this.unmountRemote.emit(remoteName);
        break;
      case "sync":
        this.syncRemote.emit(remoteName);
        break;
      case "stop-sync":
        this.stopJob.emit({ type: "sync", remoteName });
        break;
      case "copy":
        this.copyRemote.emit(remoteName);
        break;
      case "stop-copy":
        this.stopJob.emit({ type: "copy", remoteName });
        break;
      case "browse":
        this.browseRemote.emit(remoteName);
        break;
      default:
        console.warn("Unknown action:", action);
    }
  }

  onRemoteHover(remote: Remote): void {
    this.hoveredRemote = remote;
  }

  onRemoteLeave(): void {
    this.hoveredRemote = null;
  }

  @HostListener("window:keydown", ["$event"])
  onKeyDown(event: KeyboardEvent): void {
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      !this.hoveredRemote
    ) {
      return;
    }

    const key = event.key.toLowerCase();
    const remote = this.hoveredRemote;
    const remoteName = remote.remoteSpecs.name;

    const keyActions: Record<string, () => void> = {
      m: () => {
        remote.mountState?.mounted
          ? this.unmountRemote.emit(remoteName)
          : this.mountRemote.emit(remoteName);
      },
      s: () => {
        remote.syncState?.isOnSync
          ? this.stopJob.emit({ type: "sync", remoteName })
          : this.syncRemote.emit(remoteName);
      },
      c: () => {
        remote.copyState?.isOnCopy
          ? this.stopJob.emit({ type: "copy", remoteName })
          : this.copyRemote.emit(remoteName);
      },
      b: () => {
        if (remote.mountState?.mounted) {
          this.browseRemote.emit(remoteName);
        } else {
          this.infoService.openSnackBar(
            "Remote is not mounted. Please mount it first.",
            "Close"
          );
        }
      },
    };

    if (keyActions[key]) {
      keyActions[key]();
      event.preventDefault();
    }
  }
}
