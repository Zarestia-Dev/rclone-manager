import {
  Component,
  EventEmitter,
  Output,
  OnInit,
  OnDestroy,
  ChangeDetectorRef,
  signal,
} from "@angular/core";
import { CommonModule } from "@angular/common";
import { MatCardModule } from "@angular/material/card";
import { MatIconModule } from "@angular/material/icon";
import { MatButtonModule } from "@angular/material/button";
import { MatTooltipModule } from "@angular/material/tooltip";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import {
  trigger,
  transition,
  style,
  animate,
  state,
} from "@angular/animations";
import { RcloneService } from "../../../services/rclone.service";
import {
  BandwidthLimitResponse,
  MemoryStats,
  GlobalStats,
} from "../../../shared/components/types";
import { Subject, interval, of, from } from "rxjs";
import { takeUntil, catchError, switchMap } from "rxjs/operators";
import { MatExpansionModule } from "@angular/material/expansion";

interface SystemStats {
  rcloneStatus: "active" | "inactive" | "error";
  activeConnections: number;
  backgroundTasks: number;
  totalRemotes: number;
  activeJobs: number;
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
  animations: [
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
  ],
})
export class GeneralOverviewComponent implements OnInit, OnDestroy {
  // State management using signals where appropriate
  bandwidthLimit = signal<BandwidthLimitResponse | null>(null);
  isLoadingBandwidth = signal(false);
  bandwidthError = signal<string | null>(null);

  // Panel states
  bandwidthPanelOpenState = signal(false);
  systemInfoPanelOpenState = signal(false);
  jobInfoPanelOpenState = signal(false);

  // System stats with initial values
  systemStats = signal<SystemStats>({
    rcloneStatus: "inactive",
    activeConnections: 0,
    backgroundTasks: 0,
    totalRemotes: 0,
    activeJobs: 0,
    memoryUsage: "0 MB",
    uptime: "0s",
  });

  isLoadingStats = signal(false);
  jobStats = signal<GlobalStats>({ ...DEFAULT_JOB_STATS });

  private destroy$ = new Subject<void>();

  constructor(
    private rcloneService: RcloneService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.loadInitialData();
    this.setupPolling();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private loadInitialData(): void {
    this.loadBandwidthLimit();
    this.loadSystemStats();
  }

  private setupPolling(): void {
    // Bandwidth polling (every 30 seconds)
    interval(30000)
      .pipe(
        takeUntil(this.destroy$),
        switchMap(async () => this.loadBandwidthLimit())
      )
      .subscribe();

    // System stats polling (every 5 seconds)
    interval(5000)
      .pipe(
        takeUntil(this.destroy$),
        switchMap(() => this.loadSystemStats())
      )
      .subscribe();
  }

  loadBandwidthLimit() {
    if (this.isLoadingBandwidth()) return of(null);

    this.isLoadingBandwidth.set(true);
    this.bandwidthError.set(null);

    // Always convert getBandwidthLimit result to Observable
    return from(this.rcloneService.getBandwidthLimit())
      .pipe(
        catchError((error) => {
          this.bandwidthError.set("Failed to load bandwidth limit");
          console.error("Error loading bandwidth limit:", error);

          // Auto-retry after delay if first load fails
          if (!this.bandwidthLimit()) {
            setTimeout(() => this.loadBandwidthLimit(), 5000);
          }

          return of(null);
        })
      )
      .subscribe((response: BandwidthLimitResponse) => {
        if (response) {
          this.bandwidthLimit.set(response);
          this.bandwidthError.set(null);
        }
        this.isLoadingBandwidth.set(false);
        this.cdr.markForCheck();
      });
  }

  async loadSystemStats(): Promise<void> {
    if (this.isLoadingStats()) return;

    this.isLoadingStats.set(true);

    try {
      const [remotes, jobs, rcloneInfo, memoryStats, coreStats] =
        await Promise.allSettled([
          this.rcloneService.getRemotes(),
          this.rcloneService.getJobs(),
          this.rcloneService.getRcloneInfo(),
          this.rcloneService.getMemoryStats(),
          this.rcloneService.getCoreStats(),
        ]);

      const remotesResult = remotes.status === "fulfilled" ? remotes.value : [];
      const jobsResult = jobs.status === "fulfilled" ? jobs.value : [];
      const activeJobs = jobsResult.filter(
        (job: any) => job.status === "Running"
      );
      const memoryResult =
        memoryStats.status === "fulfilled" ? memoryStats.value : null;
      const coreResult =
        coreStats.status === "fulfilled" ? coreStats.value : null;

      // Update system stats
      this.systemStats.set({
        rcloneStatus: rcloneInfo.status === "fulfilled" ? "active" : "error",
        activeConnections: remotesResult.length || 0,
        backgroundTasks: activeJobs.length,
        totalRemotes: remotesResult.length || 0,
        activeJobs: activeJobs.length,
        memoryUsage: this.formatMemoryUsage(memoryResult) || "Unknown",
        uptime: this.formatUptime(coreResult?.elapsedTime || 0) || "0s",
      });

      // Update job stats
      if (coreResult) {
        this.jobStats.set({
          ...DEFAULT_JOB_STATS,
          ...coreResult,
        });
      } else {
        this.jobStats.set({ ...DEFAULT_JOB_STATS });
      }
    } catch (error) {
      console.error("Error loading system stats:", error);
      this.systemStats.update((prev) => ({ ...prev, rcloneStatus: "error" }));
    } finally {
      this.isLoadingStats.set(false);
      this.cdr.markForCheck();
    }
  }

  // Utility functions
  formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";

    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  private formatMemoryUsage(memoryStats: MemoryStats | null): string {
    if (!memoryStats?.HeapAlloc) return "Unknown";
    return `${Math.round(memoryStats.HeapAlloc / 1024 / 1024)} MB`;
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
  get jobCompletionPercentage(): number {
    const totalBytes = this.jobStats().totalBytes || 0;
    const bytes = this.jobStats().bytes || 0;
    return totalBytes > 0 ? Math.min(100, (bytes / totalBytes) * 100) : 0;
  }

  get jobStatusText(): string {
    return this.systemStats().activeJobs === 0 ? "No active jobs" : "Running";
  }

  get isBandwidthLimited(): boolean {
    const limit = this.bandwidthLimit();
    return (
      !!limit &&
      limit.rate !== "off" &&
      limit.rate !== "" &&
      limit.bytesPerSecond !== -1
    );
  }

  get formattedBandwidthRate(): string {
    const limit = this.bandwidthLimit();
    if (!limit || !this.isBandwidthLimited) return "Unlimited";

    return limit.rate.includes(":")
      ? limit.rate
          .split(":")
          .map((r, i) => `${i === 0 ? "↑" : "↓"}${this.formatRateValue(r)}`)
          .join(" ")
      : this.formatRateValue(limit.rate);
  }

  get bandwidthDisplayValue(): string {
    if (this.bandwidthError()) return "Error loading limit";
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
    switch (this.systemStats().rcloneStatus) {
      case "active":
        return "status-active";
      case "error":
        return "status-error";
      default:
        return "status-inactive";
    }
  }
}
