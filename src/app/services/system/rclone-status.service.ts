import { computed, inject, Injectable, signal, effect } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { interval, switchMap, catchError, EMPTY, from } from 'rxjs';
import { SystemInfoService } from './system-info.service';
import { BackendService } from './backend.service';
import { EventListenersService } from './event-listeners.service';
import {
  BandwidthLimitResponse,
  DEFAULT_JOB_STATS,
  GlobalStats,
  MemoryStats,
  RcloneStatus,
  RcloneInfo,
} from '@app/types';

const POLLING_INTERVAL = 1000; // 1 second

/**
 * Centralized service for managing rclone status and system statistics
 * Handles polling and provides reactive state to all components
 */
@Injectable({
  providedIn: 'root',
})
export class RcloneStatusService {
  // Signals for reactive state
  readonly rcloneStatus = signal<RcloneStatus>('inactive');
  readonly rcloneInfo = signal<RcloneInfo | null>(null);
  readonly rclonePID = signal<number | null>(null);
  readonly jobStats = signal<GlobalStats>({ ...DEFAULT_JOB_STATS });
  readonly memoryUsage = signal<MemoryStats | null>(null);
  readonly uptime = computed(() => this.jobStats().elapsedTime || 0);
  readonly isLoading = signal(false);
  readonly bandwidthLimit = signal<BandwidthLimitResponse | null>(null);

  // Flag to control polling
  private pollingEnabled = signal(true);

  // Track previous status to detect state changes
  private previousRcloneStatus: RcloneStatus = 'inactive';

  private systemInfoService = inject(SystemInfoService);
  private backendService = inject(BackendService);
  private eventListenersService = inject(EventListenersService);

  constructor() {
    this.startPolling();
    this.setupListeners();
  }

  private setupListeners(): void {
    // 1. Listen for backend changes
    // When the active backend changes, we need to reload the bandwidth limit
    // because it might be different for the new backend context
    effect(() => {
      const backend = this.backendService.activeBackend();
      if (backend) {
        void this.loadBandwidthLimit();
      }
    });

    // 2. Listen for bandwidth change events from backend/tray
    this.eventListenersService
      .listenToBandwidthLimitChanged()
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        void this.loadBandwidthLimit();
      });
  }

  /**
   * Start the polling mechanism
   * Automatically handles cleanup on service destroy
   */
  private startPolling(): void {
    interval(POLLING_INTERVAL)
      .pipe(
        switchMap(() => {
          if (!this.pollingEnabled()) {
            return EMPTY;
          }
          return from(this.loadStats());
        }),
        catchError(error => {
          console.error('[RcloneStatusService] Error during polling:', error);
          return EMPTY;
        }),
        takeUntilDestroyed()
      )
      .subscribe();

    // Load initial data immediately
    void this.loadStats();
  }

  /**
   * Load all statistics (rclone status, job stats, memory)
   * This is the main polling function
   */
  private async loadStats(): Promise<void> {
    await Promise.all([this.checkRcloneStatus(), this.loadSystemStats()]);
  }

  /**
   * Check rclone status (active/inactive/error) and update active backend status
   */
  private async checkRcloneStatus(): Promise<void> {
    try {
      const [rcloneInfo, pid] = await Promise.all([
        this.systemInfoService.getRcloneInfo(),
        this.systemInfoService.getRclonePID(),
      ]);
      const isActive = !!rcloneInfo;
      const newStatus: RcloneStatus = isActive ? 'active' : 'inactive';
      this.rcloneStatus.set(newStatus);
      this.rcloneInfo.set(rcloneInfo);
      this.rclonePID.set(pid);

      // Detect status change and reload bandwidth when backend becomes active
      if (this.previousRcloneStatus !== 'active' && newStatus === 'active') {
        void this.loadBandwidthLimit();
      }
      this.previousRcloneStatus = newStatus;

      // Update active backend status based on rclone connectivity
      const activeBackend = this.backendService.activeBackend();
      if (activeBackend && activeBackend !== 'Local') {
        this.backendService.backends.update(backends =>
          backends.map(b =>
            b.name === activeBackend
              ? {
                  ...b,
                  status: isActive ? 'connected' : 'error',
                  version: rcloneInfo?.version,
                  os: rcloneInfo?.os,
                }
              : b
          )
        );
      }
    } catch (error) {
      console.error('[RcloneStatusService] Failed to check rclone status:', error);
      this.rcloneStatus.set('error');
      this.rcloneInfo.set(null);
      this.rclonePID.set(null);
      this.previousRcloneStatus = 'error';

      // Reload bandwidth limit to reflect error state
      void this.loadBandwidthLimit();

      // Update active backend to error state
      const activeBackend = this.backendService.activeBackend();
      if (activeBackend && activeBackend !== 'Local') {
        this.backendService.backends.update(backends =>
          backends.map(b => (b.name === activeBackend ? { ...b, status: 'error' } : b))
        );
      }
    }
  }

  /**
   * Load system statistics (memory, core stats)
   */
  private async loadSystemStats(): Promise<void> {
    const hasData = this.uptime() > 0 || this.memoryUsage() !== null;

    if (!hasData) {
      this.isLoading.set(true);
    }

    try {
      const [memoryStats, coreStats] = await Promise.all([
        this.systemInfoService.getMemoryStats().catch(() => null),
        this.systemInfoService.getCoreStats().catch(() => null),
      ]);

      // Update stats
      if (coreStats) {
        this.jobStats.set(coreStats);
      } else {
        this.resetStats();
      }

      // Update memory usage
      this.memoryUsage.set(memoryStats);
    } catch (error) {
      console.error('[RcloneStatusService] Error loading system stats:', error);
      if (!hasData) {
        this.resetStats();
      }
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Reset all statistics to defaults
   */
  private resetStats(): void {
    this.jobStats.set({ ...DEFAULT_JOB_STATS });
    this.memoryUsage.set(null);
  }

  /**
   * Manually trigger a stats refresh
   * Useful when you need immediate data
   */
  async refresh(): Promise<void> {
    await Promise.all([
      this.checkRcloneStatus(),
      this.loadSystemStats(),
      this.loadBandwidthLimit(),
    ]);
  }

  /**
   * Load bandwidth limit
   */
  async loadBandwidthLimit(): Promise<void> {
    try {
      const limit = await this.systemInfoService.getBandwidthLimit();
      this.bandwidthLimit.set(limit);
    } catch (error) {
      console.error('[RcloneStatusService] Failed to load bandwidth limit:', error);
      this.bandwidthLimit.set({
        bytesPerSecond: -1,
        bytesPerSecondRx: -1,
        bytesPerSecondTx: -1,
        rate: 'off',
        loading: false,
        error: `Failed to load bandwidth limit: ${error}`,
      });
    }
  }

  /**
   * Set bandwidth limit
   */
  async setBandwidthLimit(rate?: string): Promise<BandwidthLimitResponse> {
    try {
      const response = await this.systemInfoService.setBandwidthLimit(rate);
      this.bandwidthLimit.set(response);
      return response;
    } catch (error) {
      console.error('[RcloneStatusService] Failed to set bandwidth limit:', error);
      throw error;
    }
  }

  /**
   * Pause polling (useful for performance optimization)
   */
  pausePolling(): void {
    this.pollingEnabled.set(false);
  }

  /**
   * Resume polling
   */
  resumePolling(): void {
    this.pollingEnabled.set(true);
  }

  /**
   * Check if polling is currently active
   */
  isPollingActive(): boolean {
    return this.pollingEnabled();
  }
}
