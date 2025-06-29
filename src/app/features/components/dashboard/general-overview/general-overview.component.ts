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
  TrackByFunction,
  OnChanges,
  SimpleChanges,
} from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { MatIconModule } from "@angular/material/icon";
import { MatButtonModule } from "@angular/material/button";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { MatExpansionModule } from "@angular/material/expansion";
import { Subject } from "rxjs";

import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  BandwidthLimitResponse,
  DEFAULT_JOB_STATS,
  GlobalStats,
  JobInfo,
  MemoryStats,
  Remote,
  RemoteAction,
  RemoteActionProgress,
} from "../../../../shared/components/types";
import { AnimationsService } from "../../../../services/core/animations.service";
import { RemotesPanelComponent } from "../../../../shared/overviews-shared/remotes-panel/remotes-panel.component";

/** Polling interval for system stats in milliseconds */
const POLLING_INTERVAL = 5000;

/** Default polling interval when component is in background */
const BACKGROUND_POLLING_INTERVAL = 30000;

/** System stats interface */
interface SystemStats {
  memoryUsage: string;
  uptime: string;
}

/** Rclone status type */
type RcloneStatus = "active" | "inactive" | "error";

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
    MatProgressSpinnerModule,
    MatExpansionModule,
    MatProgressBarModule,
    RemotesPanelComponent,
  ],
  templateUrl: "./general-overview.component.html",
  styleUrls: ["./general-overview.component.scss"],
  animations: [AnimationsService.fadeInOut()],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GeneralOverviewComponent implements OnInit, OnDestroy, OnChanges {
  // Input properties
  @Input() remotes: Remote[] = [];
  @Input() jobs: JobInfo[] = [];
  @Input() iconService!: { getIconName: (type: string) => string };
  @Input() actionInProgress: RemoteActionProgress = {};
  @Input() bandwidthLimit: BandwidthLimitResponse | null = null;
  @Input() systemInfoService!: any; // Replace with actual type if available

  // Output events
  @Output() selectRemote = new EventEmitter<Remote>();
  @Output() mountRemote = new EventEmitter<string>();
  @Output() unmountRemote = new EventEmitter<string>();
  @Output() startOperation = new EventEmitter<{
    type: "sync" | "copy";
    remoteName: string;
  }>();
  @Output() stopJob = new EventEmitter<{
    type: "sync" | "copy";
    remoteName: string;
  }>();
  @Output() browseRemote = new EventEmitter<string>();

  // State properties
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

  private unlistenBandwidthLimit: UnlistenFn | null = null;

  // Cache computed values to avoid recalculation
  _totalRemotes = 0;
  _activeJobsCount = 0;
  _jobCompletionPercentage = 0;

  private destroy$ = new Subject<void>();
  private isComponentVisible = true;
  private panelPollingInterval: any = null;

  // Track by function for better performance
  readonly trackByRemoteName: TrackByFunction<Remote> = (_, remote) => {
    return remote.remoteSpecs.name;
  };

  constructor(private cdr: ChangeDetectorRef) {}

  /**
   * Initialize component on ngOnInit lifecycle hook
   */
  ngOnInit(): void {
    this.initializeComponent();
    // Load initial bandwidth limit
    this.loadBandwidthLimit();
    // Set up Tauri listeners for bandwidth limit changes
    this.setupTauriListeners();
    // If any panels are initially open, start polling
    if (this.shouldPollData) {
      this.startPolling();
    }
  }

  /**
   * Clean up on ngOnDestroy lifecycle hook
   */
  ngOnDestroy(): void {
    this.stopPolling();
    this.destroy$.next();
    this.destroy$.complete();
    if (this.unlistenBandwidthLimit) {
      this.unlistenBandwidthLimit();
      this.unlistenBandwidthLimit = null;
      console.log("Unsubscribed from bandwidth limit changes");
    }
  }

  private async setupTauriListeners(): Promise<void> {
    // Bandwidth limit changed - update bandwidth limit state
    this.unlistenBandwidthLimit = await listen<BandwidthLimitResponse>(
      "bandwidth_limit_changed",
      async (event) => {
        console.log("Bandwidth limit changed:", event.payload);
        this.bandwidthLimit = await this.systemInfoService.getBandwidthLimit();
        this.cdr.markForCheck();
      }
    );
  }

  /**
   * Handle input changes on ngOnChanges lifecycle hook
   * @param changes - SimpleChanges object containing changed properties
   */
  ngOnChanges(changes: SimpleChanges): void {
    if (changes["remotes"] || changes["jobs"]) {
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
    // Don't start polling immediately - wait for panels to be opened
    console.log(
      "Component initialized - polling will start when panels are opened"
    );
  }

  /**
   * Check if any expansion panels are open and need data polling
   */
  private get shouldPollData(): boolean {
    return (
      this.isComponentVisible &&
      (this.systemInfoPanelOpenState || this.jobInfoPanelOpenState)
    );
  }

  /**
   * Update polling based on component and panel visibility
   */
  private updatePollingBasedOnVisibility(): void {
    if (this.shouldPollData) {
      this.startPolling();
    } else {
      this.stopPolling();
    }
  }

  /**
   * Stop current polling
   */
  private stopPolling(): void {
    if (this.panelPollingInterval) {
      clearInterval(this.panelPollingInterval);
      this.panelPollingInterval = null;
      console.log("Stopped polling - panels closed or component not visible");
    }
  }

  /**
   * Start polling for system stats with appropriate interval
   */
  private startPolling(): void {
    // Stop any existing polling first
    this.stopPolling();

    if (!this.shouldPollData) {
      console.log("Skipping polling - no relevant panels are open");
      return;
    }

    const interval = this.isComponentVisible
      ? POLLING_INTERVAL
      : BACKGROUND_POLLING_INTERVAL;

    console.log(`Starting polling with ${interval}ms interval`);

    // Use setInterval for better control
    this.panelPollingInterval = setInterval(() => {
      if (this.shouldPollData) {
        this.loadSystemStats().catch((err) =>
          console.error("Error in system stats polling:", err)
        );
      } else {
        this.stopPolling();
      }
    }, interval);

    // Load initial data immediately
    this.loadSystemStats().catch((err) =>
      console.error("Error loading initial system stats:", err)
    );
  }

  /**
   * Load initial data for the component
   */
  private loadInitialData(): void {
    this.checkRcloneStatus();
  }

  /**
   * Set up event listeners for reactive data
   */
  private setupEventListeners(): void {
    this.listenToRcloneStatusChanges();
  }

  /**
   * Update computed values based on current state
   */
  private updateComputedValues(): void {
    this._totalRemotes = this.remotes?.length || 0;
    this._activeJobsCount =
      this.jobs?.filter((job) => job.status === "Running").length || 0;

    const totalBytes = this.jobStats.totalBytes || 0;
    const bytes = this.jobStats.bytes || 0;
    this._jobCompletionPercentage =
      totalBytes > 0 ? Math.min(100, (bytes / totalBytes) * 100) : 0;
  }

  /**
   * Check current RClone status
   */
  private checkRcloneStatus(): void {
    this.systemInfoService
      .getRcloneInfo()
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
   * Listen to RClone status changes
   */
  private listenToRcloneStatusChanges(): void {
    // const statusStreams$ = combineLatest([
    //   this.systemInfoService.listenToRcloneApiReady(),
    //   this.systemInfoService.listenToRcloneEngineFailed(),
    //   this.systemInfoService.listenToRclonePathInvalid(),
    // ]).pipe(takeUntil(this.destroy$));
    // statusStreams$.subscribe(
    //   ([isReady, hasFailed, isInvalidPath]: [boolean, boolean, boolean]) => {
    //     if (hasFailed || isInvalidPath) {
    //       this.rcloneStatus = "error";
    //     } else if (isReady) {
    //       this.rcloneStatus = "active";
    //     } else {
    //       this.rcloneStatus = "inactive";
    //     }
    //     this.cdr.markForCheck();
    //   }
    // );
  }

  /**
   * Load system statistics
   */
  async loadSystemStats(): Promise<void> {
    if (this.isLoadingStats) {
      console.log("System stats already loading, skipping duplicate request");
      return;
    }

    if (!this.shouldPollData) {
      console.log("No panels open that need system stats, skipping load");
      return;
    }

    console.log("Loading system stats...");
    this.isLoadingStats = true;

    try {
      this.cdr.markForCheck();
      const [memoryStats, coreStats] = await Promise.all([
        this.systemInfoService.getMemoryStats(),
        this.systemInfoService.getCoreStats(),
      ]);

      this.updateSystemStats(memoryStats, coreStats);
      this.updateComputedValues();
      this.cdr.markForCheck();
    } catch (error) {
      console.error("Error loading system stats:", error);
    } finally {
      this.isLoadingStats = false;
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

  // Formatting utilities - Consolidated for better maintainability
  private readonly formatUtils = {
    bytes: (bytes: number): string => {
      if (bytes === 0) return "0 B";
      const units = ["B", "KB", "MB", "GB", "TB"];
      const i = Math.floor(Math.log(bytes) / Math.log(1024));
      return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${
        units[i]
      }`;
    },

    bytesPerSecond: (bytes: number): string => {
      if (bytes <= 0) return "Unlimited";
      return `${this.formatUtils.bytes(bytes)}/s`;
    },

    duration: (seconds: number): string => {
      if (seconds < 60) return `${Math.round(seconds)}s`;
      if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
      if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
      return `${Math.round(seconds / 86400)}d`;
    },

    eta: (eta: number | string): string => {
      if (typeof eta === "string") return eta;
      if (eta <= 0 || !isFinite(eta)) return "Unknown";
      return this.formatUtils.duration(eta);
    },

    memoryUsage: (memoryStats: MemoryStats | null): string => {
      return memoryStats?.HeapAlloc
        ? `${Math.round(memoryStats.HeapAlloc / 1024 / 1024)} MB`
        : "Unknown";
    },

    rateValue: (rate: string): string => {
      if (!rate || rate === "off" || rate === "") return "Unlimited";

      // Handle combined rates like "10Ki:100Ki" (upload:download)
      if (rate.includes(":")) {
        const [uploadRate, downloadRate] = rate.split(":");
        const uploadFormatted = this.formatUtils.parseRateString(uploadRate);
        const downloadFormatted =
          this.formatUtils.parseRateString(downloadRate);
        return `↑ ${uploadFormatted} / ↓ ${downloadFormatted}`;
      }

      // Handle single rate
      return `Limited to ${this.formatUtils.parseRateString(rate)}`;
    },

    parseRateString: (rateStr: string): string => {
      if (!rateStr || rateStr === "off") return "Unlimited";

      // Handle rclone's rate format (e.g., "10Ki", "1Mi", "100Ki")
      const match = rateStr.match(/^(\d+(?:\.\d+)?)\s*([KMGT]?i?)$/i);
      if (!match) return rateStr;

      const [, value, unit] = match;
      const numValue = parseFloat(value);

      // Convert rclone units to bytes
      const rcloneMultipliers = {
        "": 1,
        Ki: 1024,
        Mi: 1024 ** 2,
        Gi: 1024 ** 3,
        Ti: 1024 ** 4,
      };

      const multiplier =
        rcloneMultipliers[unit as keyof typeof rcloneMultipliers] || 1;
      const bytes = numValue * multiplier;

      return this.formatUtils.bytesPerSecond(bytes);
    },

    bandwidthDetails: (
      bandwidthLimit: BandwidthLimitResponse
    ): { upload: string; download: string; total: string } => {
      const isUnlimited = (value: number) => value <= 0;

      return {
        upload: isUnlimited(bandwidthLimit.bytesPerSecondTx)
          ? "Unlimited"
          : this.formatUtils.bytesPerSecond(bandwidthLimit.bytesPerSecondTx),
        download: isUnlimited(bandwidthLimit.bytesPerSecondRx)
          ? "Unlimited"
          : this.formatUtils.bytesPerSecond(bandwidthLimit.bytesPerSecondRx),
        total: isUnlimited(bandwidthLimit.bytesPerSecond)
          ? "Unlimited"
          : this.formatUtils.bytesPerSecond(bandwidthLimit.bytesPerSecond),
      };
    },
  };

  /**
   * Format bytes to human readable string
   * @param bytes - Number of bytes
   * @returns Formatted string with appropriate unit
   */
  formatBytes(bytes: number): string {
    return this.formatUtils.bytes(bytes);
  }

  /**
   * Format memory usage
   * @param memoryStats - Memory statistics
   * @returns Formatted memory usage string
   */
  private formatMemoryUsage(memoryStats: MemoryStats | null): string {
    return this.formatUtils.memoryUsage(memoryStats);
  }

  /**
   * Format uptime in seconds to human readable string
   * @param elapsedTimeSeconds - Uptime in seconds
   * @returns Formatted uptime string
   */
  formatUptime(elapsedTimeSeconds: number): string {
    return this.formatUtils.duration(elapsedTimeSeconds);
  }

  /**
   * Format ETA to human readable string
   * @param eta - ETA value (can be number or string)
   * @returns Formatted ETA string
   */
  formatEta(eta: number | string): string {
    return this.formatUtils.eta(eta);
  }

  /**
   * Format rate value to human readable string
   * @param rate - Rate string (e.g., "10MB/s")
   * @returns Formatted rate string
   */
  private formatRateValue(rate: string): string {
    return this.formatUtils.rateValue(rate);
  }

  get isBandwidthLimited(): boolean {
    if (!this.bandwidthLimit) return false;

    console.log("Checking if bandwidth is limited:", this.bandwidthLimit);

    return (
      !!this.bandwidthLimit &&
      this.bandwidthLimit.rate !== "off" &&
      this.bandwidthLimit.rate !== "" &&
      this.bandwidthLimit.bytesPerSecond > 0
    );
  }

  get formattedBandwidthRate(): string {
    if (
      !this.bandwidthLimit ||
      this.bandwidthLimit.rate === "off" ||
      this.bandwidthLimit.rate === "" ||
      this.bandwidthLimit.bytesPerSecond <= 0
    ) {
      return "Unlimited";
    }
    return this.formatRateValue(this.bandwidthLimit.rate);
  }

  get bandwidthDisplayValue(): string {
    if (this.bandwidthLimit?.loading) return "Loading...";
    if (this.bandwidthLimit?.error) return "Error loading limit";
    if (
      !this.bandwidthLimit ||
      this.bandwidthLimit.rate === "off" ||
      this.bandwidthLimit.rate === "" ||
      this.bandwidthLimit.bytesPerSecond <= 0
    ) {
      return "Unlimited";
    }
    return this.formatRateValue(this.bandwidthLimit.rate);
  }

  get bandwidthDetails() {
    if (!this.bandwidthLimit)
      return { upload: "Unknown", download: "Unknown", total: "Unknown" };
    return this.formatUtils.bandwidthDetails(this.bandwidthLimit);
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

  /**
   * Get ARIA label for a remote card
   * @param remote - Remote object
   * @returns ARIA label string
   */
  getRemoteAriaLabel(remote: Remote): string {
    const statusChecks = [
      { condition: remote.mountState?.mounted, label: "Mounted" },
      { condition: remote.syncState?.isOnSync, label: "Syncing" },
      { condition: remote.copyState?.isOnCopy, label: "Copying" },
    ];

    const activeStatuses = statusChecks
      .filter((check) => check.condition)
      .map((check) => check.label);

    const statusSuffix = activeStatuses.length
      ? ` - ${activeStatuses.join(", ")}`
      : "";
    return `${remote.remoteSpecs.name} (${remote.remoteSpecs.type})${statusSuffix}`;
  }

  /**
   * Check if remote is busy with any action
   * @param remote - Remote object
   * @returns True if remote is busy
   */
  isRemoteBusy(remote: Remote): boolean {
    return this.isAnyActionInProgress(remote.remoteSpecs.name);
  }

  async loadBandwidthLimit(): Promise<void> {
    try {
      this.bandwidthLimit = {
        bytesPerSecond: 0,
        bytesPerSecondRx: 0,
        bytesPerSecondTx: 0,
        rate: "Loading...",
        loading: true,
      };
      this.cdr.markForCheck();

      const response = await this.systemInfoService.getBandwidthLimit();
      console.log("HomeComponent: Bandwidth limit loaded:", response);

      this.bandwidthLimit = response;
    } catch (error) {
      console.error("HomeComponent: Failed to load bandwidth limit:", error);
      this.bandwidthLimit = {
        bytesPerSecond: -1,
        bytesPerSecondRx: -1,
        bytesPerSecondTx: -1,
        rate: "off",
        loading: false,
        error: `Failed to load bandwidth limit: ${error}`,
      };
    } finally {
      this.cdr.markForCheck();
    }
  }

  /**
   * Get the current action state for a remote
   * @param remoteName - Name of the remote
   * @returns The current action state
   */
  getRemoteActionState(remoteName: string): RemoteAction {
    return this.actionInProgress[remoteName] || null;
  }

  /**
   * Get the variant for a remote card based on its state
   * @param remote - Remote object
   * @returns The variant for the remote card
   */
  getRemoteVariant(remote: Remote): "active" | "inactive" | "error" {
    // Check if remote has any active operations
    if (
      remote.mountState?.mounted ||
      remote.syncState?.isOnSync ||
      remote.copyState?.isOnCopy
    ) {
      return "active";
    }

    // Check for error states (you can extend this logic based on your error handling)
    // For now, we'll default to inactive
    return "inactive";
  }

  // Remotes categorization for panel view
  get allRemotes(): Remote[] {
    return this.remotes || [];
  }

  get mountedRemotes(): Remote[] {
    return this.remotes.filter((remote) => remote.mountState?.mounted === true);
  }

  get unmountedRemotes(): Remote[] {
    return this.remotes.filter((remote) => !remote.mountState?.mounted);
  }

  get syncingRemotes(): Remote[] {
    return this.remotes.filter((remote) => remote.syncState?.isOnSync === true);
  }

  get copyingRemotes(): Remote[] {
    return this.remotes.filter((remote) => remote.copyState?.isOnCopy === true);
  }

  // Event handlers for remotes panel
  onRemoteSelectedFromPanel(remote: Remote): void {
    this.selectRemote.emit(remote);
  }

  onOpenInFilesFromPanel(remoteName: string): void {
    this.browseRemote.emit(remoteName);
  }

  onPrimaryActionFromPanel(remoteName: string): void {
    // For general overview, primary action could be mount/unmount based on current state
    const remote = this.remotes.find((r) => r.remoteSpecs.name === remoteName);
    if (remote) {
      if (remote.mountState?.mounted) {
        this.unmountRemote.emit(remoteName);
      } else {
        this.mountRemote.emit(remoteName);
      }
    }
  }

  onSecondaryActionFromPanel(remoteName: string): void {
    // Secondary action could be sync operation
    this.startOperation.emit({ type: "sync", remoteName });
  }

  // Event handlers
  // Panel state change handlers
  /**
   * Handle bandwidth panel state change
   */
  onBandwidthPanelStateChange(isOpen: boolean): void {
    this.bandwidthPanelOpenState = isOpen;
    console.log(`Bandwidth panel ${isOpen ? "opened" : "closed"}`);
    // Bandwidth panel doesn't need polling, so no action needed
  }

  /**
   * Handle system info panel state change
   */
  onSystemInfoPanelStateChange(isOpen: boolean): void {
    this.systemInfoPanelOpenState = isOpen;
    console.log(`System info panel ${isOpen ? "opened" : "closed"}`);

    if (isOpen) {
      // Load data immediately when panel opens
      this.loadSystemStats().catch((err) =>
        console.error("Error loading initial system stats:", err)
      );
    }

    this.updatePollingBasedOnVisibility();
  }

  /**
   * Handle job info panel state change
   */
  onJobInfoPanelStateChange(isOpen: boolean): void {
    this.jobInfoPanelOpenState = isOpen;
    console.log(`Job info panel ${isOpen ? "opened" : "closed"}`);

    if (isOpen) {
      // Load data immediately when panel opens
      this.loadSystemStats().catch((err) =>
        console.error("Error loading initial job stats:", err)
      );
    }

    this.updatePollingBasedOnVisibility();
  }
}
