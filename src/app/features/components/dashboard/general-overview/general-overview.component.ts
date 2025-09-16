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
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBarModule, MatSnackBar } from '@angular/material/snack-bar';
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

import {
  BandwidthLimitResponse,
  DEFAULT_JOB_STATS,
  GlobalStats,
  JobInfo,
  MemoryStats,
  PanelState,
  PrimaryActionType,
  RcloneStatus,
  Remote,
  RemoteAction,
  RemoteActionProgress,
  SystemStats,
} from '@app/types';
import { FormatFileSizePipe } from '../../../../shared/pipes/format-file-size.pipe';
import { FormatTimePipe } from '../../../../shared/pipes/format-time.pipe';
import { FormatEtaPipe } from '../../../../shared/pipes/format-eta.pipe';
import { FormatMemoryUsagePipe } from '../../../../shared/pipes/format-memory-usage.pipe';
import { FormatRateValuePipe } from '../../../../shared/pipes/format-rate-value.pipe';
import { FormatBytesPerSecondPipe } from '../../../../shared/pipes/format-bytes-per-second.pipe';
import { RemotesPanelComponent } from '../../../../shared/overviews-shared/remotes-panel/remotes-panel.component';

// Services
import { AnimationsService } from '../../../../shared/services/animations.service';
import { EventListenersService } from '@app/services';
import { SystemInfoService } from '@app/services';

/** Polling interval for system stats in milliseconds */
const POLLING_INTERVAL = 5000;

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
    MatTooltipModule,
    MatSnackBarModule,
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
  @Output() startJob = new EventEmitter<{
    type: PrimaryActionType;
    remoteName: string;
  }>();
  @Output() stopJob = new EventEmitter<{
    type: PrimaryActionType;
    remoteName: string;
  }>();
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
  private eventListenersService = inject(EventListenersService);
  private destroy$ = new Subject<void>();
  private pollingSubscription: Subscription | null = null;
  private panelStateChange$ = new Subject<void>();
  private statsUpdateDebounce$ = new Subject<void>();

  // Services
  private cdr = inject(ChangeDetectorRef);
  private ngZone = inject(NgZone);
  private snackBar = inject(MatSnackBar);

  // Track by functions
  readonly trackByRemoteName: TrackByFunction<Remote> = (_, remote) => remote.remoteSpecs.name;
  readonly trackByIndex: TrackByFunction<unknown> = index => index;

  // Pipes
  FormatFileSizePipe = new FormatFileSizePipe();
  FormatTimePipe = new FormatTimePipe();
  FormatEtaPipe = new FormatEtaPipe();
  FormatMemoryUsagePipe = new FormatMemoryUsagePipe();
  FormatRateValuePipe = new FormatRateValuePipe();
  FormatBytesPerSecondPipe = new FormatBytesPerSecondPipe();

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
    if (changes['remotes'] || changes['jobs'] || changes['actionInProgress']) {
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

  private setupTauriListeners(): void {
    this.eventListenersService
      .listenToBandwidthLimitChanged()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: async () => {
          this.bandwidthLimit = await this.systemInfoService.getBandwidthLimit();
          this.statsUpdateDebounce$.next();
        },
      });
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
    return this.FormatFileSizePipe.transform(bytes);
  }
  private formatMemoryUsage(memoryStats: MemoryStats | null): string {
    return this.FormatMemoryUsagePipe.transform(memoryStats);
  }
  formatUptime(elapsedTimeSeconds: number): string {
    return this.FormatTimePipe.transform(elapsedTimeSeconds);
  }
  formatEta(eta: number | string): string {
    return this.FormatEtaPipe.transform(eta);
  }
  private formatRateValue(rate: string): string {
    return this.FormatRateValuePipe.transform(rate);
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
    const isUnlimited = (value: number): boolean => value <= 0;
    return {
      upload: isUnlimited(this.bandwidthLimit.bytesPerSecondTx)
        ? 'Unlimited'
        : this.FormatBytesPerSecondPipe.transform(this.bandwidthLimit.bytesPerSecondTx),
      download: isUnlimited(this.bandwidthLimit.bytesPerSecondRx)
        ? 'Unlimited'
        : this.FormatBytesPerSecondPipe.transform(this.bandwidthLimit.bytesPerSecondRx),
      total: isUnlimited(this.bandwidthLimit.bytesPerSecond)
        ? 'Unlimited'
        : this.FormatBytesPerSecondPipe.transform(this.bandwidthLimit.bytesPerSecond),
    };
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

  onSecondaryActionFromPanel(remoteName: string): void {
    // Secondary action could be sync operation
    this.startJob.emit({ type: 'sync', remoteName });
  }

  // Copy error to clipboard
  async copyError(error: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(error);
      this.snackBar.open('Error copied to clipboard', 'Close', {
        duration: 2000,
      });
    } catch {
      this.snackBar.open('Failed to copy error', 'Close', {
        duration: 2000,
      });
    }
  }
}
