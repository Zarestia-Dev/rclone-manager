import { computed, inject, Injectable, signal, DestroyRef } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { DOCUMENT } from '@angular/common';
import { fromEvent, from } from 'rxjs';
import { filter, switchMap } from 'rxjs/operators';
import { SystemInfoService } from '../system/system-info.service';
import { BackendService } from '../system/backend.service';
import { EventListenersService } from '../system/event-listeners.service';
import {
  BandwidthLimitResponse,
  DEFAULT_JOB_STATS,
  GlobalStats,
  MemoryStats,
  RcloneStatus,
  RcloneInfo,
} from '@app/types';

const NORMAL_POLL_INTERVAL = 1000;
const ERROR_POLL_INTERVAL = 5000;
const PAUSED_CHECK_INTERVAL = 2000;

@Injectable({ providedIn: 'root' })
export class RcloneStatusService {
  private systemInfoService = inject(SystemInfoService);
  private backendService = inject(BackendService);
  private eventListenersService = inject(EventListenersService);
  // private rcloneUpdateService = inject(RcloneUpdateService);
  private destroyRef = inject(DestroyRef);
  private document = inject(DOCUMENT);

  readonly rcloneInfo = signal<RcloneInfo | null>(null, { equal: this.objectsEqual });
  readonly bandwidthLimit = signal<BandwidthLimitResponse | null>(null, {
    equal: this.objectsEqual,
  });
  readonly rcloneStatus = signal<RcloneStatus>('inactive');
  readonly rclonePID = signal<number | null>(null);
  readonly jobStats = signal<GlobalStats>({ ...DEFAULT_JOB_STATS });
  readonly memoryUsage = signal<MemoryStats | null>(null);
  readonly isLoading = signal(false);
  readonly uptime = computed(() => this.jobStats().elapsedTime || 0);

  private isManuallyPaused = signal(false);
  private isVisible = signal(!this.document.hidden);
  private pollingTimerId?: ReturnType<typeof setTimeout>;

  readonly isPollingActive = computed(() => {
    return !this.isManuallyPaused() && this.isVisible();
  });

  constructor() {
    this.setupListeners();
    this.triggerNextPoll(0);
    this.destroyRef.onDestroy(() => clearTimeout(this.pollingTimerId));
  }

  private setupListeners(): void {
    toObservable(this.backendService.activeBackend)
      .pipe(
        filter(Boolean),
        switchMap(() => from(this.loadBandwidthLimit())),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe();

    this.eventListenersService
      .listenToBandwidthLimitChanged()
      .pipe(
        switchMap(() => from(this.loadBandwidthLimit())),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe();

    fromEvent(this.document, 'visibilitychange')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.isVisible.set(!this.document.hidden));

    this.eventListenersService
      .listenToEngineRestarted()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.triggerNextPoll(0));
  }

  private triggerNextPoll(delay: number): void {
    clearTimeout(this.pollingTimerId);
    this.pollingTimerId = setTimeout(() => this.executePoll(), delay);
  }

  private async executePoll(): Promise<void> {
    if (!this.isPollingActive()) {
      this.triggerNextPoll(PAUSED_CHECK_INTERVAL);
      return;
    }
    await Promise.all([this.checkRcloneStatus(), this.loadSystemStats()]);
    this.triggerNextPoll(
      this.rcloneStatus() === 'error' ? ERROR_POLL_INTERVAL : NORMAL_POLL_INTERVAL
    );
  }

  private async checkRcloneStatus(): Promise<void> {
    try {
      const [rcloneInfo, pid] = await Promise.all([
        this.systemInfoService.getRcloneInfo(),
        this.systemInfoService.getRclonePID(),
      ]);
      const isActive = !!rcloneInfo;
      const newStatus: RcloneStatus = isActive ? 'active' : 'inactive';
      const wasActive = this.rcloneStatus() === 'active';

      this.rcloneStatus.set(newStatus);
      this.rcloneInfo.set(rcloneInfo);
      this.rclonePID.set(pid);

      if (!wasActive && newStatus === 'active') void this.loadBandwidthLimit();

      this.backendService.updateActiveBackendStatus(isActive ? 'connected' : 'error', {
        version: rcloneInfo?.version,
        os: rcloneInfo?.os,
      });
    } catch (error) {
      const wasError = this.rcloneStatus() === 'error';
      if (!wasError) {
        console.error('[RcloneStatusService] Failed to check rclone status:', error);
        void this.loadBandwidthLimit();
      }
      this.rcloneStatus.set('error');
      this.rcloneInfo.set(null);
      this.rclonePID.set(null);
      this.backendService.updateActiveBackendStatus('error');
    }
  }

  private async loadSystemStats(): Promise<void> {
    const hasData = this.uptime() > 0 || this.memoryUsage() !== null;
    if (!hasData) this.isLoading.set(true);

    try {
      const [memoryStats, coreStats] = await Promise.all([
        this.systemInfoService.getMemoryStats().catch(() => null),
        this.systemInfoService.getStats().catch(() => null),
      ]);
      const stats = coreStats ?? { ...DEFAULT_JOB_STATS };
      this.jobStats.update(old => ({
        ...stats,
        lastError: stats.lastError || old.lastError,
      }));
      this.memoryUsage.set(memoryStats);
    } catch (error) {
      if (this.rcloneStatus() !== 'error') {
        console.error('[RcloneStatusService] Error loading system stats:', error);
      }
      if (!hasData) this.jobStats.set({ ...DEFAULT_JOB_STATS });
    } finally {
      if (this.isLoading()) this.isLoading.set(false);
    }
  }

  async refresh(): Promise<void> {
    await Promise.all([
      this.checkRcloneStatus(),
      this.loadSystemStats(),
      this.loadBandwidthLimit(),
    ]);
  }

  async loadBandwidthLimit(): Promise<void> {
    try {
      this.bandwidthLimit.set(await this.systemInfoService.getBandwidthLimit());
    } catch (error) {
      if (this.rcloneStatus() !== 'error') {
        console.error('[RcloneStatusService] Failed to load bandwidth limit:', error);
      }
      this.bandwidthLimit.set({
        bytesPerSecond: -1,
        bytesPerSecondRx: -1,
        bytesPerSecondTx: -1,
        rate: 'off',
        loading: false,
        error: `Failed: ${error}`,
      });
    }
  }

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

  pausePolling(): void {
    this.isManuallyPaused.set(true);
  }
  resumePolling(): void {
    this.isManuallyPaused.set(false);
  }

  private objectsEqual<T>(a: T, b: T): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return JSON.stringify(a) === JSON.stringify(b);
  }
}
