import { computed, inject, Injectable, signal, DestroyRef, effect } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { DOCUMENT } from '@angular/common';
import { fromEvent, from } from 'rxjs';
import { filter, switchMap, tap } from 'rxjs/operators';
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
  SystemStatusPayload,
} from '@app/types';

@Injectable({ providedIn: 'root' })
export class RcloneStatusService {
  private systemInfoService = inject(SystemInfoService);
  private backendService = inject(BackendService);
  private eventListenersService = inject(EventListenersService);
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
  readonly isLoading = signal(true);
  readonly uptime = computed(() => this.jobStats().elapsedTime || 0);

  private isManuallyPaused = signal(false);
  private isVisible = signal(!this.document.hidden);

  readonly isPollingActive = computed(() => {
    return !this.isManuallyPaused() && this.isVisible();
  });

  constructor() {
    this.setupReconciliationTriggers();
    this.setupPollingControl();
    this.setupStatusListeners();
    void this.refreshStatus();
  }

  async refreshStatus(): Promise<void> {
    await this.hydrateSystemStatus();
  }

  private setupPollingControl(): void {
    effect(() => {
      const active = this.isPollingActive();
      void this.systemInfoService.setPollerVisibility(active);
    });
  }

  private setupStatusListeners(): void {
    toObservable(this.backendService.activeBackend)
      .pipe(
        filter(Boolean),
        filter(() => !this.isLoading()),
        tap(() => {
          this.isLoading.set(true);
          this.rcloneStatus.set('inactive');
          this.rcloneInfo.set(null);
          this.rclonePID.set(null);
        }),
        switchMap(() => from(this.hydrateSystemStatus())),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe();

    this.eventListenersService
      .listenToBandwidthLimitChanged()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(data => {
        if (data) {
          this.bandwidthLimit.set(data as BandwidthLimitResponse);
        }
      });

    fromEvent(this.document, 'visibilitychange')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        const isVisible = !this.document.hidden;
        this.isVisible.set(isVisible);
        if (isVisible) {
          void this.hydrateSystemStatus();
        }
      });

    this.eventListenersService
      .listenToSystemStatus()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(payload => this.applySystemStatusPayload(payload));
  }

  private setupReconciliationTriggers(): void {
    this.eventListenersService
      .listenToRcloneEngineReady()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        void this.hydrateSystemStatus();
      });
  }

  private async hydrateSystemStatus(): Promise<void> {
    try {
      const snapshot = await this.systemInfoService.getSystemStatusSnapshot();
      this.applySystemStatusPayload(snapshot);
      await this.loadBandwidthLimit();
    } catch (error) {
      console.error('[RcloneStatusService] Failed to hydrate system status snapshot:', error);
      if (this.isLoading()) this.isLoading.set(false);
    }
  }

  private applySystemStatusPayload(payload: SystemStatusPayload): void {
    const newStatus: RcloneStatus = payload.status;

    this.rcloneStatus.set(newStatus);
    this.rcloneInfo.set(payload.rcloneInfo);
    this.rclonePID.set(payload.pid);

    if (payload.stats) {
      const stats = payload.stats;
      this.jobStats.update(old => ({
        ...stats,
        lastError: stats.lastError || old.lastError,
      }));
    }

    this.memoryUsage.set(payload.memory);

    this.backendService.updateActiveBackendStatus(
      newStatus === 'active'
        ? { type: 'connected' }
        : newStatus === 'inactive'
          ? { type: 'inactive' }
          : { type: 'error', message: 'Engine offline' },
      {
        version: payload.rcloneInfo?.version,
        os: payload.rcloneInfo?.os,
      }
    );

    if (this.isLoading()) this.isLoading.set(false);
  }

  async loadBandwidthLimit(): Promise<void> {
    try {
      this.bandwidthLimit.set(await this.systemInfoService.bandwidthLimit());
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
