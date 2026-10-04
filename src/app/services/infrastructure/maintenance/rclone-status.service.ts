import { computed, inject, Injectable, signal, DestroyRef, effect } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { DOCUMENT } from '@angular/common';
import { fromEvent, from } from 'rxjs';
import { filter, switchMap, tap } from 'rxjs/operators';
import { VaultService } from '../../security/vault.service';
import { SystemInfoService } from '../system/system-info.service';
import { BackendService } from '../system/backend.service';
import { EventListenersService } from '../system/event-listeners.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import {
  BandwidthLimitResponse,
  DEFAULT_JOB_STATS,
  GlobalStats,
  MemoryStats,
  RcloneStatus,
  RcloneInfo,
  SystemStatusPayload,
} from '@app/types';
import { deepEqual } from 'src/app/shared/utils';

@Injectable({ providedIn: 'root' })
export class RcloneStatusService {
  private systemInfoService = inject(SystemInfoService);
  private backendService = inject(BackendService);
  private eventListenersService = inject(EventListenersService);
  private appSettingsService = inject(AppSettingsService);
  private destroyRef = inject(DestroyRef);
  private document = inject(DOCUMENT);

  private readonly vault = inject(VaultService);
  private readonly canLoad = this.vault.isAccessible;

  readonly rcloneInfo = signal<RcloneInfo | null>(null, { equal: deepEqual });
  readonly bandwidthLimit = signal<BandwidthLimitResponse | null>(null, {
    equal: deepEqual,
  });
  readonly savedBandwidthLimit = computed(() => {
    const opts = this.appSettingsService.options();
    return ((opts?.['core.bandwidth_limit']?.value as string) ?? '').trim();
  });
  readonly rcloneStatus = signal<RcloneStatus>('inactive');
  readonly rclonePID = signal<number | null>(null);
  readonly jobStats = signal<GlobalStats>(structuredClone(DEFAULT_JOB_STATS));
  readonly memoryUsage = signal<MemoryStats | null>(null);
  readonly isLoading = signal(true);
  readonly uptime = computed(() => this.jobStats().elapsedTime || 0);

  private isManuallyPaused = signal(false);
  private isVisible = signal(!this.document.hidden);

  readonly isPollingActive = computed(() => {
    return this.canLoad() && !this.isManuallyPaused() && this.isVisible();
  });

  constructor() {
    this.setupReconciliationTriggers();
    this.setupPollingControl();
    this.setupStatusListeners();
    if (this.canLoad()) {
      void this.refreshStatus();
    }
    this.eventListenersService
      .listenToVaultState()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(payload => {
        if (!payload.isLocked) {
          void this.refreshStatus();
        }
      });
  }

  async refreshStatus(): Promise<void> {
    await this.hydrateSystemStatus();
  }

  private setupPollingControl(): void {
    effect(() => {
      const active = this.isPollingActive();
      void this.systemInfoService.setPollerVisibility(active).catch(error => {
        console.error('[RcloneStatusService] Failed to update polling visibility:', error);
      });
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
        if (this.canLoad() && data) {
          this.bandwidthLimit.set(data);
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
    if (!this.canLoad()) return;
    try {
      const snapshot = await this.systemInfoService.getSystemStatusSnapshot();
      if (!this.canLoad()) return;
      this.applySystemStatusPayload(snapshot);
      await this.loadBandwidthLimit();
    } catch (error) {
      console.error('[RcloneStatusService] Failed to hydrate system status snapshot:', error);
      if (this.isLoading()) this.isLoading.set(false);
    }
  }

  private applySystemStatusPayload(payload: SystemStatusPayload): void {
    if (!this.canLoad()) return;
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
    if (!this.canLoad()) return;
    try {
      const limit = await this.systemInfoService.bandwidthLimit();
      if (this.canLoad()) this.bandwidthLimit.set(limit);
    } catch (error) {
      if (!this.canLoad()) return;
      if (this.rcloneStatus() !== 'error') {
        console.error('[RcloneStatusService] Failed to load bandwidth limit:', error);
      }
      this.bandwidthLimit.set({
        bytesPerSecond: -1,
        bytesPerSecondRx: -1,
        bytesPerSecondTx: -1,
        rate: 'off',
        loading: false,
        error: `Failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  async setBandwidthLimit(rate: string): Promise<void> {
    const persistedValue = rate === 'off' ? '' : rate;
    await this.systemInfoService.bandwidthLimit(rate);
    await this.appSettingsService.saveSetting('core', 'bandwidth_limit', persistedValue);
  }

  pausePolling(): void {
    this.isManuallyPaused.set(true);
  }
  resumePolling(): void {
    this.isManuallyPaused.set(false);
  }
}
