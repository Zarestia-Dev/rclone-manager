import { DestroyRef, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslateService } from '@ngx-translate/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ApiClientService, isHeadlessMode } from '../platform/api-client.service';
import { EventListenersService } from './event-listeners.service';
import { NotificationService } from '../../ui/notification.service';
import { NautilusService } from '../../ui/nautilus.service';
import { FlowOverlayService } from '../../ui/flow-overlay.service';
import { MainUiOverlayService } from '../../ui/main-ui-overlay.service';
import { VaultService } from '../../security/vault.service';
import { ActiveOperationsSummary, SystemPowerAction } from '@app/types';

@Injectable({ providedIn: 'root' })
export class AppLifecycleService {
  private readonly eventListenersService = inject(EventListenersService);
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly apiClient = inject(ApiClientService);
  private readonly nautilusService = inject(NautilusService);
  private readonly flowOverlayService = inject(FlowOverlayService);
  private readonly mainUiOverlayService = inject(MainUiOverlayService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly vaultService = inject(VaultService);
  readonly lockedExitRequested = signal(false);
  readonly isQuitting = signal(false);
  private readonly pendingExitSummary = signal<ActiveOperationsSummary | null>(null);

  constructor() {
    effect(() => {
      if (!this.vaultService.isStatusKnown()) return;
      if (this.lockedExitRequested() && !this.vaultService.isVaultLocked()) {
        this.lockedExitRequested.set(false);
        this.pendingExitSummary.set(null);
        // Request a fresh summary after unlocking; the locked notice has redacted counts.
        untracked(() => {
          void this.apiClient.invoke('request_app_exit').catch(error => {
            this.notificationService.showError(error);
          });
        });
        return;
      }
      const summary = this.pendingExitSummary();
      if (!summary) return;
      this.pendingExitSummary.set(null);
      untracked(() => void this.promptExitConfirmation(summary));
    });
  }

  cancelLockedExit(): void {
    if (!this.isQuitting()) this.lockedExitRequested.set(false);
  }

  async confirmLockedExit(): Promise<void> {
    if (!this.lockedExitRequested() || this.isQuitting()) return;
    this.isQuitting.set(true);
    try {
      await this.shutdownApp();
      this.lockedExitRequested.set(false);
    } finally {
      this.isQuitting.set(false);
    }
  }

  private exitListenerInitialized = false;
  private isConfirmModalOpen = false;

  public initialize(): void {
    if (this.exitListenerInitialized) {
      return;
    }

    this.exitListenerInitialized = true;

    // Do not handle app exit in secondary standalone windows
    if (this.isStandaloneWindow()) {
      return;
    }

    this.eventListenersService
      .listenToAppExitRequested()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(summary => {
        void this.promptExitConfirmation(summary);
      });

    // Native listener registration is asynchronous; restore pending exits only once it is ready.
    this.eventListenersService
      .whenAppExitListenerReady()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => void this.checkPendingExit(),
        error: error => console.error('Failed to register app exit listener:', error),
      });
  }

  private async checkPendingExit(): Promise<void> {
    try {
      const summary = await this.apiClient.invoke<ActiveOperationsSummary | null>(
        'check_pending_app_exit'
      );
      if (summary?.hasActiveOperations) {
        await this.promptExitConfirmation(summary);
      }
    } catch {
      // Ignore if not supported or failed
    }
  }

  private async promptExitConfirmation(summary: ActiveOperationsSummary): Promise<void> {
    if (this.isQuitting()) return;
    // A tray exit can recreate the main window before its vault status arrives.
    if (!this.vaultService.isStatusKnown()) {
      this.pendingExitSummary.set(summary);
      return;
    }
    if (this.vaultService.isVaultLocked()) {
      this.lockedExitRequested.set(true);
      return;
    }
    if (
      summary.hasActiveOperations &&
      summary.activeJobsCount === 0 &&
      summary.activeMountsCount === 0 &&
      summary.activeServesCount === 0
    ) {
      // A redacted notice can arrive before the window learns that the vault was unlocked.
      try {
        await this.apiClient.invoke('request_app_exit');
      } catch (error) {
        this.notificationService.showError(error);
      }
      return;
    }
    if (this.isConfirmModalOpen) {
      return;
    }
    this.isConfirmModalOpen = true;

    try {
      const confirmed = await this.notificationService.confirmModal(
        'app.shutdown.confirmTitle',
        this.translate.instant('app.shutdown.confirmMessage', {
          jobs: summary.activeJobsCount,
          mounts: summary.activeMountsCount,
          serves: summary.activeServesCount,
        }),
        'app.shutdown.stopAndQuit',
        'common.cancel',
        { icon: 'warning', color: 'warn' }
      );

      if (!this.vaultService.isAccessible()) {
        // Vault transitions close protected dialogs; keep the exit request for the lock screen.
        this.pendingExitSummary.set(summary);
        return;
      }
      if (confirmed) {
        await this.shutdownApp();
      }
    } catch (error) {
      this.notificationService.showError(error);
    } finally {
      this.isConfirmModalOpen = false;
    }
  }

  async shutdownApp(): Promise<void> {
    await this.apiClient.invoke('shutdown_app');
  }

  async relaunchApp(): Promise<void> {
    await this.apiClient.invoke('relaunch_app');
  }

  async executeSystemPower(action: SystemPowerAction): Promise<void> {
    await this.apiClient.invoke('execute_system_power', { action });
  }

  private isStandaloneWindow(): boolean {
    return (
      (!isHeadlessMode() && getCurrentWindow().label !== 'main') ||
      new URLSearchParams(window.location.search).has('standalone') ||
      this.nautilusService.isStandaloneWindow() ||
      this.flowOverlayService.isStandaloneWindow() ||
      this.mainUiOverlayService.isStandaloneWindow()
    );
  }
}
