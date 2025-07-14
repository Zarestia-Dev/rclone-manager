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
  // Input/Output Properties
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

  // Component State
  rcloneStatus: RcloneStatus = 'inactive';
  systemStats: SystemStats = { memoryUsage: '0 MB', uptime: '0s' };
  jobStats: GlobalStats = { ...DEFAULT_JOB_STATS };
  isLoadingStats = false;

  // Panel states
  bandwidthPanelOpenState = false;
  systemInfoPanelOpenState = false;
  jobInfoPanelOpenState = false;

  // Computed properties
  _totalRemotes = 0;
  _activeJobsCount = 0;
  _jobCompletionPercentage = 0;

  // Private members
  private readonly PANEL_STATE_KEY = 'dashboard_panel_states';
  private unlistenBandwidthLimit: UnlistenFn | null = null;
  private destroy$ = new Subject<void>();
  private pollingSubscription: Subscription | null = null;
  private panelStateChange$ = new Subject<void>();
  private statsUpdateDebounce$ = new Subject<void>();

  // Services
  private cdr = inject(ChangeDetectorRef);
  private ngZone = inject(NgZone);

  // Track by functions
  readonly trackByRemoteName: TrackByFunction<Remote> = (_, remote) => remote.remoteSpecs.name;
  readonly trackByIndex: TrackByFunction<unknown> = index => index;

  ngOnInit(): void {
    this.restorePanelStates();
    this.setupTauriListeners();
    this.setupPolling();
    this.loadInitialData();

    // Debounce panel state changes to prevent rapid toggling
    this.panelStateChange$
      .pipe(debounceTime(300), takeUntil(this.destroy$))
      .subscribe(() => this.cdr.markForCheck());

    // Debounce stats updates
    this.statsUpdateDebounce$
      .pipe(debounceTime(100), takeUntil(this.destroy$))
      .subscribe(() => this.cdr.markForCheck());
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['remotes'] || changes['jobs']) {
      this.updateComputedValues();
      this.statsUpdateDebounce$.next();
    }
  }

  // Panel state management
  expandAllPanels(): void {
    this.bandwidthPanelOpenState = true;
    this.systemInfoPanelOpenState = true;
    this.jobInfoPanelOpenState = true;
    this.savePanelStates();
  }

  collapseAllPanels(): void {
    this.bandwidthPanelOpenState = false;
    this.systemInfoPanelOpenState = false;
    this.jobInfoPanelOpenState = false;
    this.savePanelStates();
  }

  // Panel state change handlers
  onBandwidthPanelStateChange(isOpen: boolean): void {
    this.bandwidthPanelOpenState = isOpen;
    this.savePanelStates();
    this.panelStateChange$.next();
  }

  onSystemInfoPanelStateChange(isOpen: boolean): void {
    this.systemInfoPanelOpenState = isOpen;
    this.savePanelStates();
    this.panelStateChange$.next();
  }

  onJobInfoPanelStateChange(isOpen: boolean): void {
    this.jobInfoPanelOpenState = isOpen;
    this.savePanelStates();
    this.panelStateChange$.next();
  }

  // Private methods
  private cleanup(): void {
    this.stopPolling();
    this.destroy$.next();
    this.destroy$.complete();

    if (this.unlistenBandwidthLimit) {
      this.unlistenBandwidthLimit();
      this.unlistenBandwidthLimit = null;
    }
  }

  private setupPolling(): void {
    this.stopPolling();

    // Immediate first load
    this.loadSystemStats().catch(err => {
      console.error('Initial system stats load failed:', err);
    });

    // Start regular polling
    this.pollingSubscription = timer(POLLING_INTERVAL, POLLING_INTERVAL)
      .pipe(
        takeUntil(this.destroy$),
        filter(() => !this.isLoadingStats),
        switchMap(() =>
          from(this.loadSystemStats()).pipe(
            catchError(err => {
              console.error('Error in system stats polling:', err);
              return EMPTY;
            })
          )
        )
      )
      .subscribe();
  }

  private stopPolling(): void {
    if (this.pollingSubscription) {
      this.pollingSubscription.unsubscribe();
      this.pollingSubscription = null;
    }
  }

  private async loadInitialData(): Promise<void> {
    await Promise.all([this.checkRcloneStatus(), this.loadBandwidthLimit()]);
    this.statsUpdateDebounce$.next();
  }

  private async checkRcloneStatus(): Promise<void> {
    try {
      const rcloneInfo = await this.systemInfoService.getRcloneInfo();
      this.rcloneStatus = rcloneInfo ? 'active' : 'inactive';
      console.log('Rclone status:', this.rcloneStatus);
    } catch {
      this.rcloneStatus = 'error';
    }
  }

  private async loadSystemStats(): Promise<void> {
    if (this.isLoadingStats) return;

    this.isLoadingStats = true;
    this.statsUpdateDebounce$.next();

    try {
      // Load system stats independently of Rclone status
      const [memoryStats, coreStats] = await Promise.all([
        this.systemInfoService.getMemoryStats(),
        this.systemInfoService.getCoreStats().catch(err => {
          console.error('Error loading core stats:', err);
          return null;
        }),
      ]);

      this.ngZone.run(async () => {
        this.updateSystemStats(memoryStats, coreStats);
        this.updateComputedValues();
        this.checkRcloneStatus();
      });
    } catch (error) {
      console.error('Error loading system stats:', error);
      this.ngZone.run(() => {
        this.jobStats = { ...DEFAULT_JOB_STATS };
        this.systemStats = { memoryUsage: 'Error', uptime: 'Error' };
      });
    } finally {
      this.isLoadingStats = false;
      this.statsUpdateDebounce$.next();
    }
  }

  private updateSystemStats(memoryStats: MemoryStats | null, coreStats: GlobalStats | null): void {
    if (coreStats) {
      this.jobStats = { ...this.jobStats, ...coreStats };
      this.systemStats.memoryUsage = this.formatMemoryUsage(memoryStats);
      this.systemStats.uptime = this.formatUptime(coreStats.elapsedTime || 0);
    } else {
      this.jobStats = { ...DEFAULT_JOB_STATS };
      this.systemStats.memoryUsage = this.formatMemoryUsage(memoryStats);
      this.systemStats.uptime = '0s';
    }
  }

  private updateComputedValues(): void {
    this._totalRemotes = this.remotes?.length || 0;
    this._activeJobsCount = this.jobs?.filter(job => job.status === 'Running').length || 0;

    const totalBytes = this.jobStats.totalBytes || 0;
    const bytes = this.jobStats.bytes || 0;
    this._jobCompletionPercentage = totalBytes > 0 ? Math.min(100, (bytes / totalBytes) * 100) : 0;
  }

  private async setupTauriListeners(): Promise<void> {
    this.unlistenBandwidthLimit = await listen<BandwidthLimitResponse>(
      'bandwidth_limit_changed',
      async () => {
        this.bandwidthLimit = await this.systemInfoService.getBandwidthLimit();
        this.statsUpdateDebounce$.next();
      }
    );
  }

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

  // Formatting methods (keep existing implementations)
  formatBytes(bytes: number): string {
    return formatUtils.bytes(bytes);
  }
  private formatMemoryUsage(memoryStats: MemoryStats | null): string {
    return formatUtils.memoryUsage(memoryStats);
  }
  formatUptime(elapsedTimeSeconds: number): string {
    return formatUtils.duration(elapsedTimeSeconds);
  }
  formatEta(eta: number | string): string {
    return formatUtils.eta(eta);
  }
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
}
