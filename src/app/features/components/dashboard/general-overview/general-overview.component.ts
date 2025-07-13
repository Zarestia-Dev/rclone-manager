import { CommonModule } from '@angular/common';
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
  inject,
  NgZone,
} from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatExpansionModule } from '@angular/material/expansion';
import {
  catchError,
  debounceTime,
  EMPTY,
  filter,
  from,
  retry,
  Subject,
  Subscription,
  switchMap,
  takeUntil,
  timer,
} from 'rxjs';

import { listen, UnlistenFn } from '@tauri-apps/api/event';
import {
  BandwidthLimitResponse,
  DEFAULT_JOB_STATS,
  GlobalStats,
  JobInfo,
  MemoryStats,
  Remote,
  RemoteAction,
  RemoteActionProgress,
} from '../../../../shared/components/types';
import { AnimationsService } from '../../../../services/core/animations.service';
import { RemotesPanelComponent } from '../../../../shared/overviews-shared/remotes-panel/remotes-panel.component';
import { SystemInfoService } from '../../../../services/system/system-info.service';
import { formatUtils } from '../../../../shared/utils/format-utils';

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
type RcloneStatus = 'active' | 'inactive' | 'error';

export interface PanelState {
  bandwidth: boolean;
  system: boolean;
  jobs: boolean;
}

export interface BandwidthDetails {
  upload: string;
  download: string;
  total: string;
}

/**
 * GeneralOverviewComponent displays an overview of RClone remotes and system information
 */
@Component({
  selector: 'app-general-overview',
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
  templateUrl: './general-overview.component.html',
  styleUrls: ['./general-overview.component.scss'],
  animations: [AnimationsService.fadeInOut()],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GeneralOverviewComponent implements OnInit, OnDestroy, OnChanges {
  // === Input/Output Properties ===
  @Input() remotes: Remote[] = [];
  @Input() jobs: JobInfo[] = [];
  @Input() iconService!: { getIconName: (type: string) => string };
  @Input() actionInProgress: RemoteActionProgress = {};
  @Input() bandwidthLimit: BandwidthLimitResponse | null = null;
  @Input() systemInfoService!: SystemInfoService;

  @Output() selectRemote = new EventEmitter<Remote>();
  @Output() mountRemote = new EventEmitter<string>();
  @Output() unmountRemote = new EventEmitter<string>();
  @Output() startOperation = new EventEmitter<{ type: 'sync' | 'copy'; remoteName: string }>();
  @Output() stopJob = new EventEmitter<{ type: 'sync' | 'copy'; remoteName: string }>();
  @Output() browseRemote = new EventEmitter<string>();

  // === Component State ===
  rcloneStatus: RcloneStatus = 'inactive';
  systemStats: SystemStats = { memoryUsage: '0 MB', uptime: '0s' };
  jobStats: GlobalStats = { ...DEFAULT_JOB_STATS };
  isLoadingStats = false;

  // Panel states
  bandwidthPanelOpenState = false;
  systemInfoPanelOpenState = false;
  jobInfoPanelOpenState = false;

  // Computed properties cache
  _totalRemotes = 0;
  _activeJobsCount = 0;
  _jobCompletionPercentage = 0;

  // === Private Members ===
  private readonly PANEL_STATE_KEY = 'dashboard_panel_states';
  private unlistenBandwidthLimit: UnlistenFn | null = null;
  private destroy$ = new Subject<void>();
  private isComponentVisible = true;
  private pollingSubscription: Subscription | null = null;
  private updateStatsSubject = new Subject<void>();

  // === Services ===
  private cdr = inject(ChangeDetectorRef);
  private ngZone = inject(NgZone);

  // Track by function for better performance
  readonly trackByRemoteName: TrackByFunction<Remote> = (_, remote) => {
    return remote.remoteSpecs.name;
  };

  // Panel state memory
  private pollingDebounceTimeout: ReturnType<typeof setTimeout> | null = null;
  private handleVisibilityChange: () => void = () => {
    this.isComponentVisible = !document.hidden;
    this.updatePollingBasedOnVisibility();
  };

  // For expand/collapse all
  expandAllPanels(): void {
    this.bandwidthPanelOpenState = true;
    this.systemInfoPanelOpenState = true;
    this.jobInfoPanelOpenState = true;
    this.savePanelStates();
    this.updatePollingBasedOnVisibility();
  }
  collapseAllPanels(): void {
    this.bandwidthPanelOpenState = false;
    this.systemInfoPanelOpenState = false;
    this.jobInfoPanelOpenState = false;
    this.savePanelStates();
    this.updatePollingBasedOnVisibility();
  }

  // Panel order customization stub
  panelOrder: string[] = ['remotes', 'bandwidth', 'system', 'jobs'];
  // TODO: Implement drag-and-drop and persist order
  /**
   * Initialize component on ngOnInit lifecycle hook
   */
  ngOnInit(): void {
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.restorePanelStates();
    this.initializeComponent();
    // Load initial bandwidth limit
    this.loadBandwidthLimit();
    // Set up Tauri listeners for bandwidth limit changes
    this.setupTauriListeners();
    // If any panels are initially open, start polling
    if (this.shouldPollData) {
      this.startPolling();
    }

    this.updateStatsSubject.pipe(debounceTime(300), takeUntil(this.destroy$)).subscribe(() => {
      this.cdr.markForCheck();
    });
  }

  /**
   * Clean up on ngOnDestroy lifecycle hook
   */
  ngOnDestroy(): void {
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.stopPolling();
    this.destroy$.next();
    this.destroy$.complete();
    if (this.unlistenBandwidthLimit) {
      this.unlistenBandwidthLimit();
      this.unlistenBandwidthLimit = null;
      console.log('Unsubscribed from bandwidth limit changes');
    }
  }

  private async setupTauriListeners(): Promise<void> {
    // Bandwidth limit changed - update bandwidth limit state
    this.unlistenBandwidthLimit = await listen<BandwidthLimitResponse>(
      'bandwidth_limit_changed',
      async event => {
        console.log('Bandwidth limit changed:', event.payload);
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
    // Don't start polling immediately - wait for panels to be opened
    console.log('Component initialized - polling will start when panels are opened');
  }

  /**
   * Check if any expansion panels are open and need data polling
   */
  private get shouldPollData(): boolean {
    return this.isComponentVisible && (this.systemInfoPanelOpenState || this.jobInfoPanelOpenState);
  }

  /**
   * Update polling based on component and panel visibility
   */
  private updatePollingBasedOnVisibility(): void {
    if (this.pollingDebounceTimeout) {
      clearTimeout(this.pollingDebounceTimeout);
    }
    this.pollingDebounceTimeout = setTimeout(() => {
      if (this.shouldPollData) {
        this.startPolling();
      } else {
        this.stopPolling();
      }
    }, 200);
  }

  /**
   * Stop current polling
   */
  private stopPolling(): void {
    if (this.pollingSubscription) {
      this.pollingSubscription.unsubscribe();
      this.pollingSubscription = null;
    }
  }

  /**
   * Start polling for system stats with appropriate interval
   */
  private startPolling(): void {
    this.stopPolling();

    if (!this.shouldPollData) {
      console.log('Skipping polling - no relevant panels are open');
      return;
    }

    const interval = this.isComponentVisible ? POLLING_INTERVAL : BACKGROUND_POLLING_INTERVAL;

    this.pollingSubscription = timer(0, interval)
      .pipe(
        takeUntil(this.destroy$),
        filter(() => this.shouldPollData && !this.isLoadingStats),
        switchMap(() =>
          from(this.loadSystemStats()).pipe(
            catchError(err => {
              console.error('Error in system stats polling:', err);
              return EMPTY;
            })
          )
        ),
        retry({
          count: 3,
          delay: error => {
            console.error('Retrying after error:', error);
            return timer(1000);
          },
        })
      )
      .subscribe();
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
    this._activeJobsCount = this.jobs?.filter(job => job.status === 'Running').length || 0;

    const totalBytes = this.jobStats.totalBytes || 0;
    const bytes = this.jobStats.bytes || 0;
    this._jobCompletionPercentage = totalBytes > 0 ? Math.min(100, (bytes / totalBytes) * 100) : 0;
  }

  /**
   * Check current RClone status
   */
  private checkRcloneStatus(): void {
    this.systemInfoService
      .getRcloneInfo()
      .then(rcloneInfo => {
        this.rcloneStatus = rcloneInfo ? 'active' : 'inactive';
        this.cdr.markForCheck();
      })
      .catch(() => {
        this.rcloneStatus = 'error';
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
    if (this.isLoadingStats || !this.shouldPollData) {
      return;
    }

    this.isLoadingStats = true;
    this.updateStatsSubject.next(); // Trigger UI update

    try {
      const [memoryStats, coreStats] = await Promise.all([
        this.systemInfoService.getMemoryStats(),
        this.systemInfoService.getCoreStats().catch(err => {
          console.error('Error loading core stats:', err);
          return null;
        }),
      ]);

      this.ngZone.run(() => {
        this.updateSystemStats(memoryStats, coreStats);
        this.updateComputedValues();
      });
    } catch (error) {
      console.error('Error loading system stats:', error);
      this.ngZone.run(() => {
        this.jobStats = { ...DEFAULT_JOB_STATS };
        this.systemStats = { memoryUsage: 'Error', uptime: 'Error' };
        this.cdr.markForCheck();
      });
    } finally {
      this.isLoadingStats = false;
    }
  }

  /**
   * Update system statistics
   * @param memoryStats - Memory usage statistics
   * @param coreStats - Core system statistics
   */
  private updateSystemStats(memoryStats: MemoryStats | null, coreStats: GlobalStats | null): void {
    if (coreStats) {
      if (!this.jobStats) this.jobStats = { ...DEFAULT_JOB_STATS };
      Object.assign(this.jobStats, coreStats);
      if (!this.systemStats) this.systemStats = { memoryUsage: '0 MB', uptime: '0s' };
      this.systemStats.memoryUsage = this.formatMemoryUsage(memoryStats);
      this.systemStats.uptime = this.formatUptime(coreStats.elapsedTime || 0);
    } else {
      if (!this.jobStats) this.jobStats = { ...DEFAULT_JOB_STATS };
      Object.assign(this.jobStats, DEFAULT_JOB_STATS);
      if (!this.systemStats) this.systemStats = { memoryUsage: '0 MB', uptime: '0s' };
      this.systemStats.memoryUsage = this.formatMemoryUsage(memoryStats);
      this.systemStats.uptime = '0s';
    }
    this.cdr.markForCheck();
  }

  // Formatting utilities - Consolidated for better maintainability
  private readonly formatUtils = {
    bytes: (bytes: number): string => {
      if (bytes === 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(1024));
      return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${units[i]}`;
    },

    bytesPerSecond: (bytes: number): string => {
      if (bytes <= 0) return 'Unlimited';
      return `${this.formatUtils.bytes(bytes)}/s`;
    },

    duration: (seconds: number): string => {
      if (seconds < 60) return `${Math.round(seconds)}s`;
      if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
      if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
      return `${Math.round(seconds / 86400)}d`;
    },

    eta: (eta: number | string): string => {
      if (typeof eta === 'string') return eta;
      if (eta <= 0 || !isFinite(eta)) return 'Unknown';
      return this.formatUtils.duration(eta);
    },

    memoryUsage: (memoryStats: MemoryStats | null): string => {
      return memoryStats?.HeapAlloc
        ? `${Math.round(memoryStats.HeapAlloc / 1024 / 1024)} MB`
        : 'Unknown';
    },

    rateValue: (rate: string): string => {
      if (!rate || rate === 'off' || rate === '') return 'Unlimited';

      // Handle combined rates like "10Ki:100Ki" (upload:download)
      if (rate.includes(':')) {
        const [uploadRate, downloadRate] = rate.split(':');
        const uploadFormatted = this.formatUtils.parseRateString(uploadRate);
        const downloadFormatted = this.formatUtils.parseRateString(downloadRate);
        return `↑ ${uploadFormatted} / ↓ ${downloadFormatted}`;
      }

      // Handle single rate
      return `Limited to ${this.formatUtils.parseRateString(rate)}`;
    },

    parseRateString: (rateStr: string): string => {
      if (!rateStr || rateStr === 'off') return 'Unlimited';

      // Handle rclone's rate format (e.g., "10Ki", "1Mi", "100Ki")
      const match = rateStr.match(/^(\d+(?:\.\d+)?)\s*([KMGT]?i?)$/i);
      if (!match) return rateStr;

      const [, value, unit] = match;
      const numValue = parseFloat(value);

      // Convert rclone units to bytes
      const rcloneMultipliers = {
        '': 1,
        Ki: 1024,
        Mi: 1024 ** 2,
        Gi: 1024 ** 3,
        Ti: 1024 ** 4,
      };

      const multiplier = rcloneMultipliers[unit as keyof typeof rcloneMultipliers] || 1;
      const bytes = numValue * multiplier;

      return this.formatUtils.bytesPerSecond(bytes);
    },

    bandwidthDetails: (
      bandwidthLimit: BandwidthLimitResponse
    ): { upload: string; download: string; total: string } => {
      const isUnlimited = (value: number): boolean => value <= 0;

      return {
        upload: isUnlimited(bandwidthLimit.bytesPerSecondTx)
          ? 'Unlimited'
          : this.formatUtils.bytesPerSecond(bandwidthLimit.bytesPerSecondTx),
        download: isUnlimited(bandwidthLimit.bytesPerSecondRx)
          ? 'Unlimited'
          : this.formatUtils.bytesPerSecond(bandwidthLimit.bytesPerSecondRx),
        total: isUnlimited(bandwidthLimit.bytesPerSecond)
          ? 'Unlimited'
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
    return formatUtils.bytes(bytes);
  }

  /**
   * Format memory usage
   * @param memoryStats - Memory statistics
   * @returns Formatted memory usage string
   */
  private formatMemoryUsage(memoryStats: MemoryStats | null): string {
    return formatUtils.memoryUsage(memoryStats);
  }

  /**
   * Format uptime in seconds to human readable string
   * @param elapsedTimeSeconds - Uptime in seconds
   * @returns Formatted uptime string
   */
  formatUptime(elapsedTimeSeconds: number): string {
    return formatUtils.duration(elapsedTimeSeconds);
  }

  /**
   * Format ETA to human readable string
   * @param eta - ETA value (can be number or string)
   * @returns Formatted ETA string
   */
  formatEta(eta: number | string): string {
    return formatUtils.eta(eta);
  }

  /**
   * Format rate value to human readable string
   * @param rate - Rate string (e.g., "10MB/s")
   * @returns Formatted rate string
   */
  private formatRateValue(rate: string): string {
    return formatUtils.rateValue(rate);
  }

  get isBandwidthLimited(): boolean {
    if (!this.bandwidthLimit) return false;
    return (
      !!this.bandwidthLimit &&
      this.bandwidthLimit.rate !== 'off' &&
      this.bandwidthLimit.rate !== '' &&
      this.bandwidthLimit.bytesPerSecond > 0
    );
  }

  get formattedBandwidthRate(): string {
    if (
      !this.bandwidthLimit ||
      this.bandwidthLimit.rate === 'off' ||
      this.bandwidthLimit.rate === '' ||
      this.bandwidthLimit.bytesPerSecond <= 0
    ) {
      return 'Unlimited';
    }
    return this.formatRateValue(this.bandwidthLimit.rate);
  }

  get bandwidthDisplayValue(): string {
    if (this.bandwidthLimit?.loading) return 'Loading...';
    if (this.bandwidthLimit?.error) return 'Error loading limit';
    if (
      !this.bandwidthLimit ||
      this.bandwidthLimit.rate === 'off' ||
      this.bandwidthLimit.rate === '' ||
      this.bandwidthLimit.bytesPerSecond <= 0
    ) {
      return 'Unlimited';
    }
    return this.formatRateValue(this.bandwidthLimit.rate);
  }

  get bandwidthDetails(): { upload: string; download: string; total: string } {
    if (!this.bandwidthLimit) return { upload: 'Unknown', download: 'Unknown', total: 'Unknown' };
    return formatUtils.bandwidthDetails(this.bandwidthLimit);
  }

  // TrackBy for job stats/info grids
  trackByIndex(index: number): number {
    return index;
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
      { condition: remote.mountState?.mounted, label: 'Mounted' },
      { condition: remote.syncState?.isOnSync, label: 'Syncing' },
      { condition: remote.copyState?.isOnCopy, label: 'Copying' },
    ];

    const activeStatuses = statusChecks.filter(check => check.condition).map(check => check.label);

    const statusSuffix = activeStatuses.length ? ` - ${activeStatuses.join(', ')}` : '';
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
        rate: 'Loading...',
        loading: true,
      };
      this.cdr.markForCheck();

      const response = await this.systemInfoService.getBandwidthLimit();
      console.log('HomeComponent: Bandwidth limit loaded:', response);

      this.bandwidthLimit = response;
    } catch (error) {
      console.error('HomeComponent: Failed to load bandwidth limit:', error);
      this.bandwidthLimit = {
        bytesPerSecond: -1,
        bytesPerSecondRx: -1,
        bytesPerSecondTx: -1,
        rate: 'off',
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
  getRemoteVariant(remote: Remote): 'active' | 'inactive' | 'error' {
    // Check if remote has any active operations
    if (remote.mountState?.mounted || remote.syncState?.isOnSync || remote.copyState?.isOnCopy) {
      return 'active';
    }

    // Check for error states (you can extend this logic based on your error handling)
    // For now, we'll default to inactive
    return 'inactive';
  }

  // Remotes categorization for panel view
  get allRemotes(): Remote[] {
    return this.remotes || [];
  }

  get mountedRemotes(): Remote[] {
    return this.remotes.filter(remote => remote.mountState?.mounted === true);
  }

  get unmountedRemotes(): Remote[] {
    return this.remotes.filter(remote => !remote.mountState?.mounted);
  }

  get syncingRemotes(): Remote[] {
    return this.remotes.filter(remote => remote.syncState?.isOnSync === true);
  }

  get copyingRemotes(): Remote[] {
    return this.remotes.filter(remote => remote.copyState?.isOnCopy === true);
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
    const remote = this.remotes.find(r => r.remoteSpecs.name === remoteName);
    if (remote) {
      if (remote.mountState?.mounted) {
        this.unmountRemote.emit(remoteName);
        this.cdr.markForCheck();
      } else {
        this.mountRemote.emit(remoteName);
        this.cdr.markForCheck();
      }
    }
  }

  onSecondaryActionFromPanel(remoteName: string): void {
    // Secondary action could be sync operation
    this.startOperation.emit({ type: 'sync', remoteName });
  }

  // Event handlers
  // Panel state change handlers
  /**
   * Handle bandwidth panel state change
   */
  onBandwidthPanelStateChange(isOpen: boolean): void {
    this.bandwidthPanelOpenState = isOpen;
    this.savePanelStates();
    this.updatePollingBasedOnVisibility();
  }

  /**
   * Handle system info panel state change
   */
  onSystemInfoPanelStateChange(isOpen: boolean): void {
    this.systemInfoPanelOpenState = isOpen;
    this.savePanelStates();
    this.updatePollingBasedOnVisibility();
    if (isOpen) {
      this.loadSystemStats();
    }
  }

  /**
   * Handle job info panel state change
   */
  onJobInfoPanelStateChange(isOpen: boolean): void {
    this.jobInfoPanelOpenState = isOpen;
    this.savePanelStates();
    this.updatePollingBasedOnVisibility();
    if (isOpen) {
      this.loadSystemStats();
    }
  }

  // Panel state memory
  private savePanelStates(): void {
    const state: PanelState = {
      bandwidth: this.bandwidthPanelOpenState,
      system: this.systemInfoPanelOpenState,
      jobs: this.jobInfoPanelOpenState,
    };
    localStorage.setItem(this.PANEL_STATE_KEY, JSON.stringify(state));
  }

  private restorePanelStates(): void {
    const state = localStorage.getItem(this.PANEL_STATE_KEY);
    if (state) {
      try {
        const parsed = JSON.parse(state) as PanelState;
        this.bandwidthPanelOpenState = parsed.bandwidth ?? false;
        this.systemInfoPanelOpenState = parsed.system ?? false;
        this.jobInfoPanelOpenState = parsed.jobs ?? false;
      } catch (err) {
        console.error('Failed to parse panel state:', err);
        localStorage.removeItem(this.PANEL_STATE_KEY);
      }
    }
  }
}
