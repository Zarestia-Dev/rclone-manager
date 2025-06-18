import { CommonModule } from "@angular/common";
import {
  Component,
  OnInit,
  OnDestroy,
  Input,
  Output,
  EventEmitter,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  HostListener,
  TrackByFunction,
  OnChanges,
  SimpleChanges,
} from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { MatIconModule } from "@angular/material/icon";
import { MatButtonModule } from "@angular/material/button";
import { MatTooltipModule } from "@angular/material/tooltip";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { MatExpansionModule } from "@angular/material/expansion";
import { trigger, transition, style, animate } from "@angular/animations";
import { Subject, timer, from, combineLatest, of } from "rxjs";
import { takeUntil, switchMap, catchError, finalize } from "rxjs/operators";

import { RcloneService } from "../../../services/rclone.service";
import { InfoService } from "../../../services/info.service";
import {
  BandwidthLimitResponse,
  MemoryStats,
  GlobalStats,
  JobInfo,
  Remote,
  RemoteActionProgress,
  DEFAULT_JOB_STATS,
} from "../../../shared/components/types";

/** Constants for remote actions */

/** Keyboard shortcuts configuration */
const KEYBOARD_SHORTCUTS = {
  MOUNT: 'm',
  SYNC: 's',
  COPY: 'c',
  BROWSE: 'b',
} as const;

/** Polling interval for system stats in milliseconds */
const POLLING_INTERVAL = 5000;

/** Default polling interval when component is in background */
const BACKGROUND_POLLING_INTERVAL = 30000;

/** System stats interface */
interface SystemStats {
  memoryUsage: string;
  uptime: string;
}

/** Action emitters mapping */
interface ActionEmitters {
  [key: string]: (remoteName: string) => void;
}

/** Rclone status type */
type RcloneStatus = "active" | "inactive" | "error";

/** Animation definitions */
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

/**
 * GeneralOverviewComponent displays an overview of RClone remotes and system information
 */
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
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GeneralOverviewComponent implements OnInit, OnDestroy, OnChanges {
  // Input properties
  @Input() remotes: Remote[] = [];
  @Input() jobs: JobInfo[] = [];
  @Input() iconService!: { getIconName: (type: string) => string };
  @Input() actionInProgress: RemoteActionProgress = {};

  // Output events
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

  // State properties
  bandwidthLimit: BandwidthLimitResponse | null = null;
  isLoadingBandwidth = false;
  bandwidthError: string | null = null;
  rcloneStatus: RcloneStatus = "inactive";
  
  // Panel states
  bandwidthPanelOpenState = false;
  systemInfoPanelOpenState = false;
  jobInfoPanelOpenState = false;

  // Computed properties
  systemStats: SystemStats = {
    memoryUsage: "0 MB",
    uptime: "0s",
  };
  
  isLoadingStats = false;
  jobStats: GlobalStats = { ...DEFAULT_JOB_STATS };
  
  // Cache computed values to avoid recalculation
  private _totalRemotes = 0;
  private _activeJobsCount = 0;
  private _jobCompletionPercentage = 0;

  private destroy$ = new Subject<void>();
  hoveredRemote: Remote | null = null;
  private isComponentVisible = true;
  
  // Track by function for better performance
  readonly trackByRemoteName: TrackByFunction<Remote> = (_, remote) => remote.remoteSpecs.name;

  // Action emitters map for cleaner event handling
  private readonly actionEmitters: ActionEmitters = {
    "mount": (remoteName) => this.mountRemote.emit(remoteName),
    "unmount": (remoteName) => this.unmountRemote.emit(remoteName),
    "sync": (remoteName) => this.syncRemote.emit(remoteName),
    "copy": (remoteName) => this.copyRemote.emit(remoteName),
    "browse": (remoteName) => this.browseRemote.emit(remoteName),
  };

  constructor(
    private rcloneService: RcloneService,
    private cdr: ChangeDetectorRef,
    private infoService: InfoService
  ) {}

  /**
   * Initialize component on ngOnInit lifecycle hook
   */
  ngOnInit(): void {
    this.initializeComponent();
    this.setupVisibilityListener();
  }

  /**
   * Clean up on ngOnDestroy lifecycle hook
   */
  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  /**
   * Handle input changes on ngOnChanges lifecycle hook
   * @param changes - SimpleChanges object containing changed properties
   */
  ngOnChanges(changes: SimpleChanges): void {
    if (changes['remotes'] || changes['jobs']) {
      this.updateComputedValues();
      this.cdr.markForCheck();
    }
  }

  /**
   * Initialize component state and subscriptions
   */
  private initializeComponent(): void {
    this.loadInitialData();
    this.setupEventListeners();
    this.updateComputedValues();
    this.startPolling();
  }

  /**
   * Set up visibility change listener to optimize polling
   */
  private setupVisibilityListener(): void {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        this.isComponentVisible = !document.hidden;
        this.startPolling(); // Restart polling with appropriate interval
      });
    }
  }

  /**
   * Start polling for system stats with appropriate interval
   */
  private startPolling(): void {
    const interval = this.isComponentVisible ? POLLING_INTERVAL : BACKGROUND_POLLING_INTERVAL;
    
    // Clear any existing polling
    this.destroy$.next();
    
    timer(0, interval)
      .pipe(
        takeUntil(this.destroy$),
        switchMap(() => from(this.loadSystemStats()))
      )
      .subscribe({
        error: (err) => console.error("Error in system stats polling:", err),
      });
  }

  /**
   * Load initial data for the component
   */
  private loadInitialData(): void {
    this.loadBandwidthLimit();
    this.checkRcloneStatus();
  }

  /**
   * Set up event listeners for reactive data
   */
  private setupEventListeners(): void {
    this.listenToBandwidthChanges();
    this.listenToRcloneStatusChanges();
  }

  /**
   * Update computed values based on current state
   */
  private updateComputedValues(): void {
    this._totalRemotes = this.remotes?.length || 0;
    this._activeJobsCount = this.jobs?.filter((job) => job.status === "Running").length || 0;
    
    const totalBytes = this.jobStats.totalBytes || 0;
    const bytes = this.jobStats.bytes || 0;
    this._jobCompletionPercentage = totalBytes > 0 ? Math.min(100, (bytes / totalBytes) * 100) : 0;
  }

  /**
   * Check current RClone status
   */
  private checkRcloneStatus(): void {
    this.rcloneService.getRcloneInfo()
      .then((status: any) => {
        this.rcloneStatus = status ? "active" : "inactive";
        this.cdr.markForCheck();
      })
      .catch(() => {
        this.rcloneStatus = "error";
        this.cdr.markForCheck();
      });
  }

  /**
   * Listen to bandwidth changes
   */
  private listenToBandwidthChanges(): void {
    this.rcloneService.listenToBandwidthChanges()
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.loadBandwidthLimit());
  }

  /**
   * Listen to RClone status changes
   */
  private listenToRcloneStatusChanges(): void {
    const statusStreams$ = combineLatest([
      this.rcloneService.listenToRcloneApiReady(),
      this.rcloneService.listenToRcloneEngineFailed(),
      this.rcloneService.listenToRclonePathInvalid(),
    ]).pipe(takeUntil(this.destroy$));

    statusStreams$.subscribe(([isReady, hasFailed, isInvalidPath]: [boolean, boolean, boolean]) => {
      if (hasFailed || isInvalidPath) {
        this.rcloneStatus = "error";
      } else if (isReady) {
        this.rcloneStatus = "active";
      } else {
        this.rcloneStatus = "inactive";
      }
      this.cdr.markForCheck();
    });
  }

  /**
   * Load bandwidth limit information
   */
  loadBandwidthLimit(): void {
    if (this.isLoadingBandwidth) {
      return;
    }
    
    this.isLoadingBandwidth = true;
    this.bandwidthError = null;
    this.cdr.markForCheck();

    from(this.rcloneService.getBandwidthLimit())
      .pipe(
        takeUntil(this.destroy$),
        catchError((error) => {
          this.bandwidthError = "Failed to load bandwidth limit. Please try again.";
          console.error("Error loading bandwidth limit:", error);
          return of(null);
        }),
        finalize(() => {
          this.isLoadingBandwidth = false;
          this.cdr.markForCheck();
        })
      )
      .subscribe((limit) => {
        this.bandwidthLimit = limit;
      });
  }

  /**
   * Load system statistics
   */
  async loadSystemStats(): Promise<void> {
    if (this.isLoadingStats) {
      return;
    }
    
    this.isLoadingStats = true;
    this.cdr.markForCheck();

    try {
      const [memoryStats, coreStats] = await Promise.all([
        this.rcloneService.getMemoryStats(), 
        this.rcloneService.getCoreStats(),   
      ]);
      
      this.updateSystemStats(memoryStats, coreStats);
      this.updateComputedValues();
    } catch (error) {
      console.error("Error loading system stats:", error);
    } finally {
      this.isLoadingStats = false;
      this.cdr.markForCheck();
    }
  }

  /**
   * Update system statistics
   * @param memoryStats - Memory usage statistics
   * @param coreStats - Core system statistics
   */
  private updateSystemStats(
    memoryStats: MemoryStats | null,
    coreStats: GlobalStats | null
  ): void {
    if (coreStats) {
      this.jobStats = { ...coreStats };
      this.systemStats = {
        memoryUsage: this.formatMemoryUsage(memoryStats),
        uptime: this.formatUptime(coreStats.elapsedTime || 0),
      };
    } else {
      this.jobStats = { ...DEFAULT_JOB_STATS };
      this.systemStats = {
        memoryUsage: this.formatMemoryUsage(memoryStats),
        uptime: "0s",
      };
    }
  }

  // Formatting utilities
  /**
   * Format bytes to human readable string
   * @param bytes - Number of bytes
   * @returns Formatted string with appropriate unit
   */
  formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";

    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  /**
   * Format memory usage
   * @param memoryStats - Memory statistics
   * @returns Formatted memory usage string
   */
  private formatMemoryUsage(memoryStats: MemoryStats | null): string {
    return memoryStats?.HeapAlloc
      ? `${Math.round(memoryStats.HeapAlloc / 1024 / 1024)} MB`
      : "Unknown";
  }

  /**
   * Format uptime in seconds to human readable string
   * @param elapsedTimeSeconds - Uptime in seconds
   * @returns Formatted uptime string
   */
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

  /**
   * Format ETA to human readable string
   * @param eta - ETA value (can be number or string)
   * @returns Formatted ETA string
   */
  formatEta(eta: number | string): string {
    if (!eta) return "0s";
    if (typeof eta === "number") return `${Math.max(eta, 0)}s`;

    const match = eta.match(/(?:(\d+)m)?(?:(\d+)s)?/);
    return match
      ? `${parseInt(match[1] || "0") * 60 + parseInt(match[2] || "0")}s`
      : eta;
  }

  /**
   * Format bytes per second to human readable string
   * @param bytes - Bytes per second
   * @returns Formatted string with appropriate unit
   */
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

  /**
   * Format rate value to human readable string
   * @param rate - Rate string (e.g., "10MB/s")
   * @returns Formatted rate string
   */
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

  // Computed properties
  get totalRemotes(): number {
    return this._totalRemotes;
  }

  get activeJobsCount(): number {
    return this._activeJobsCount;
  }

  get jobCompletionPercentage(): number {
    return this._jobCompletionPercentage;
  }

  get isBandwidthLimited(): boolean {
    return (
      !!this.bandwidthLimit &&
      this.bandwidthLimit.rate !== "off" &&
      this.bandwidthLimit.rate !== ""
    );
  }

  get formattedBandwidthRate(): string {
    if (!this.bandwidthLimit || this.bandwidthLimit.rate === "off" || this.bandwidthLimit.rate === "") {
      return "Unlimited";
    }
    return this.formatRateValue(this.bandwidthLimit.rate);
  }

  get bandwidthDisplayValue(): string {
    if (this.isLoadingBandwidth) return "Loading...";
    if (this.bandwidthError) return "Error loading limit";
    if (!this.bandwidthLimit || this.bandwidthLimit.rate === "off" || this.bandwidthLimit.rate === "") {
      return "Unlimited";
    }
    return this.formatRateValue(this.bandwidthLimit.rate);
  }

  // Action Progress Utilities
  /**
   * Check if an action is in progress for a remote
   * @param remoteName - Name of the remote
   * @param action - Action to check
   * @returns True if action is in progress
   */
  isActionInProgress(remoteName: string, action: string): boolean {
    return this.actionInProgress[remoteName] === action;
  }

  /**
   * Check if any action is in progress for a remote
   * @param remoteName - Name of the remote
   * @returns True if any action is in progress
   */
  isAnyActionInProgress(remoteName: string): boolean {
    return !!this.actionInProgress[remoteName];
  }

  // Specific action state checks
  isMounting = (remoteName: string): boolean => 
    this.isActionInProgress(remoteName, "mount");

  isUnmounting = (remoteName: string): boolean => 
    this.isActionInProgress(remoteName, "unmount");

  isSyncing = (remoteName: string): boolean => 
    this.isActionInProgress(remoteName, "sync");

  isStoppingSyncing = (remoteName: string): boolean => 
    this.isActionInProgress(remoteName, "stop");

  isCopying = (remoteName: string): boolean => 
    this.isActionInProgress(remoteName, "copy");

  isStoppingCopying = (remoteName: string): boolean => 
    this.isActionInProgress(remoteName, "stop");

  isBrowsing = (remoteName: string): boolean => 
    this.isActionInProgress(remoteName, "open");

  /**
   * Get ARIA label for a remote card
   * @param remote - Remote object
   * @returns ARIA label string
   */
  getRemoteAriaLabel(remote: Remote): string {
    const status = [];
    if (remote.mountState?.mounted) status.push('Mounted');
    if (remote.syncState?.isOnSync) status.push('Syncing');
    if (remote.copyState?.isOnCopy) status.push('Copying');
    
    return `${remote.remoteSpecs.name} (${remote.remoteSpecs.type})${status.length ? ` - ${status.join(', ')}` : ''}`;
  }

  /**
   * Check if remote is busy with any action
   * @param remote - Remote object
   * @returns True if remote is busy
   */
  isRemoteBusy(remote: Remote): boolean {
    return this.isAnyActionInProgress(remote.remoteSpecs.name);
  }

  // Event handlers
  /**
   * Handle quick action button clicks
   * @param event - Click event
   * @param remoteName - Name of the remote
   * @param action - Action to perform
   */
  onQuickAction(event: Event, remoteName: string, action: string): void {
    event.stopPropagation();

    const emitter = this.actionEmitters[action];
    if (emitter) {
      emitter(remoteName);
      return;
    }

    // Handle stop actions
    if (action === 'stop-sync') {
      this.stopJob.emit({ type: "sync", remoteName });
    } else if (action === 'stop-copy') {
      this.stopJob.emit({ type: "copy", remoteName });
    } else {
      console.warn("Unknown action:", action);
    }
  }

  /**
   * Handle remote hover event
   * @param remote - Hovered remote
   */
  onRemoteHover(remote: Remote): void {
    this.hoveredRemote = remote;
  }

  /**
   * Handle remote leave event
   */
  onRemoteLeave(): void {
    this.hoveredRemote = null;
  }

  /**
   * Handle keyboard shortcuts
   * @param event - Keyboard event
   */
  @HostListener("window:keydown", ["$event"])
  onKeyDown(event: KeyboardEvent): void {
    if (this.shouldIgnoreKeyEvent(event)) return;

    const key = event.key.toLowerCase();
    const remote = this.hoveredRemote!;
    const remoteName = remote.remoteSpecs.name;

    const keyAction = this.getKeyAction(key, remote);
    if (keyAction) {
      keyAction();
      event.preventDefault();
    }
  }

  /**
   * Check if key event should be ignored
   * @param event - Keyboard event
   * @returns True if event should be ignored
   */
  private shouldIgnoreKeyEvent(event: KeyboardEvent): boolean {
    return (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      !this.hoveredRemote
    );
  }

  /**
   * Get action for keyboard shortcut
   * @param key - Pressed key
   * @param remote - Remote object
   * @returns Action function or null
   */
  private getKeyAction(key: string, remote: Remote): (() => void) | null {
    const remoteName = remote.remoteSpecs.name;

    switch (key) {
      case KEYBOARD_SHORTCUTS.MOUNT:
        return () => {
          remote.mountState?.mounted
            ? this.unmountRemote.emit(remoteName)
            : this.mountRemote.emit(remoteName);
        };
      
      case KEYBOARD_SHORTCUTS.SYNC:
        return () => {
          remote.syncState?.isOnSync
            ? this.stopJob.emit({ type: "sync", remoteName })
            : this.syncRemote.emit(remoteName);
        };
      
      case KEYBOARD_SHORTCUTS.COPY:
        return () => {
          remote.copyState?.isOnCopy
            ? this.stopJob.emit({ type: "copy", remoteName })
            : this.copyRemote.emit(remoteName);
        };
      
      case KEYBOARD_SHORTCUTS.BROWSE:
        return () => {
          if (remote.mountState?.mounted) {
            this.browseRemote.emit(remoteName);
          } else {
            this.infoService.openSnackBar(
              "Remote is not mounted. Please mount it first.",
              "Close"
            );
          }
        };
      
      default:
        return null;
    }
  }
}