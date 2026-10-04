import { DestroyRef, inject, Injectable, NgZone, signal, computed } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { VaultInfo, VaultStatePayload } from '@app/types';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';

@Injectable({
  providedIn: 'root',
})
export class VaultService extends TauriBaseService {
  private readonly eventListeners = inject(EventListenersService);
  private readonly zone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);

  private readonly _isStatusKnown = signal<boolean>(false);
  private readonly _isVaultEnabled = signal<boolean>(false);
  private readonly _isVaultLocked = signal<boolean>(false);
  private readonly _lockTimeoutSecs = signal<number | null>(null);
  private readonly _isBusy = signal<boolean>(false);

  readonly isStatusKnown = this._isStatusKnown.asReadonly();
  readonly isVaultEnabled = this._isVaultEnabled.asReadonly();
  readonly isVaultLocked = this._isVaultLocked.asReadonly();
  readonly lockTimeoutSecs = this._lockTimeoutSecs.asReadonly();
  readonly isBusy = this._isBusy.asReadonly();

  readonly isAccessible = computed(() => this.isStatusKnown() && !this.isVaultLocked());

  private stateRevision = 0;
  private lastTouchTime = 0;
  private readonly touchThrottleMs = 30_000;

  constructor() {
    super();
    this.initEventListener();
    if (!this.isTauri) {
      this.eventListeners
        .listenToServerConnection()
        .pipe(takeUntilDestroyed())
        .subscribe(() => {
          void this.checkVaultStatus().catch(() => {
            // The unknown-status screen offers retry when the server is unreachable.
          });
        });
    }
    this.initActivityTracker();
  }

  private applyVaultState(payload: {
    isEnabled: boolean;
    isLocked: boolean;
    lockTimeout?: number | null;
  }): void {
    this._isVaultEnabled.set(payload.isEnabled);
    this._isVaultLocked.set(payload.isLocked);
    this._lockTimeoutSecs.set(payload.lockTimeout ?? null);
    this._isStatusKnown.set(true);
  }

  private initEventListener(): void {
    this.eventListeners
      .listenToVaultState()
      .pipe(takeUntilDestroyed())
      .subscribe((payload: VaultStatePayload) => {
        this.stateRevision++;
        this.applyVaultState(payload);
      });
  }

  private initActivityTracker(): void {
    if (typeof window === 'undefined') return;

    this.zone.runOutsideAngular(() => {
      const onActivity = (): void => {
        if (!this.isStatusKnown() || !this.isVaultEnabled() || this.isVaultLocked()) return;
        const timeout = this.lockTimeoutSecs();
        if (!timeout) return;
        const now = Date.now();
        if (now - this.lastTouchTime >= Math.min(this.touchThrottleMs, timeout * 500)) {
          this.lastTouchTime = now;
          void this.touchVault();
        }
      };

      const onFocus = (): void => {
        void this.checkVaultStatus().catch(() => {
          // Status refresh failure on focus is recorded as status unknown
        });
      };

      window.addEventListener('pointerdown', onActivity, { passive: true });
      window.addEventListener('keydown', onActivity, { passive: true });
      window.addEventListener('focus', onFocus, { passive: true });

      this.destroyRef.onDestroy(() => {
        window.removeEventListener('pointerdown', onActivity);
        window.removeEventListener('keydown', onActivity);
        window.removeEventListener('focus', onFocus);
      });
    });
  }

  /**
   * Refresh current vault status from backend.
   * Throws if status cannot be fetched, recording status as unknown.
   */
  async checkVaultStatus(): Promise<VaultInfo> {
    const revision = ++this.stateRevision;
    try {
      const info = await this.invokeCommand<VaultInfo>('get_vault_info');
      if (revision === this.stateRevision) {
        this.applyVaultState({
          isEnabled: info.enabled,
          isLocked: info.isLocked,
          lockTimeout: info.lockTimeoutSecs,
        });
      }
      return info;
    } catch (err) {
      if (revision === this.stateRevision) this._isStatusKnown.set(false);
      console.error('Failed to get vault info:', err);
      throw err;
    }
  }

  /**
   * Unlock configuration vault with master password.
   * State update is event-driven from backend.
   */
  async unlockVault(password: string): Promise<void> {
    this._isBusy.set(true);
    try {
      await this.invokeWithNotification(
        'unlock_vault',
        { password },
        {
          successKey: 'backendSuccess.vault.unlocked',
        }
      );
      this.lastTouchTime = Date.now();
    } finally {
      await this.refreshAfterOperation();
      this._isBusy.set(false);
    }
  }

  /**
   * Lock configuration vault immediately.
   * State update is event-driven from backend.
   */
  async lockVault(): Promise<void> {
    this._isBusy.set(true);
    try {
      await this.invokeWithNotification('lock_vault', undefined, {
        successKey: 'backendSuccess.vault.locked',
      });
    } finally {
      await this.refreshAfterOperation();
      this._isBusy.set(false);
    }
  }

  /**
   * Enable configuration vault and encrypt existing settings.
   * State update is event-driven from backend.
   */
  async enableVault(password: string, timeoutSecs?: number): Promise<void> {
    this._isBusy.set(true);
    try {
      await this.invokeWithNotification(
        'enable_vault',
        { password, timeoutSecs },
        {
          successKey: 'backendSuccess.vault.enabled',
        }
      );
      this.lastTouchTime = Date.now();
    } finally {
      await this.refreshAfterOperation();
      this._isBusy.set(false);
    }
  }

  /**
   * Disable configuration vault and restore plaintext storage.
   * State update is event-driven from backend.
   */
  async disableVault(password: string): Promise<void> {
    this._isBusy.set(true);
    try {
      await this.invokeWithNotification(
        'disable_vault',
        { password },
        {
          successKey: 'backendSuccess.vault.disabled',
        }
      );
    } finally {
      await this.refreshAfterOperation();
      this._isBusy.set(false);
    }
  }

  /**
   * Change master password of the configuration vault
   */
  async changeVaultPassword(oldPassword: string, newPassword: string): Promise<void> {
    this._isBusy.set(true);
    try {
      await this.invokeWithNotification(
        'change_vault_password',
        { oldPassword, newPassword },
        {
          successKey: 'backendSuccess.vault.passwordChanged',
        }
      );
    } finally {
      await this.refreshAfterOperation();
      this._isBusy.set(false);
    }
  }

  /**
   * Configure or clear auto-lock inactivity timeout
   */
  async setVaultLockTimeout(timeoutSecs?: number): Promise<void> {
    this._isBusy.set(true);
    try {
      await this.invokeWithNotification(
        'set_vault_lock_timeout',
        { timeoutSecs },
        {
          successKey: 'backendSuccess.vault.timeoutUpdated',
        }
      );
    } finally {
      await this.refreshAfterOperation();
      this._isBusy.set(false);
    }
  }

  private async refreshAfterOperation(): Promise<void> {
    try {
      await this.checkVaultStatus();
    } catch {
      // Keep status unknown on transport failure; preserve the original command error.
    }
  }

  /**
   * Reset the auto-lock inactivity countdown without disk I/O
   */
  async touchVault(): Promise<void> {
    try {
      await this.invokeCommand('touch_vault');
    } catch {
      // Best-effort keepalive
    }
  }
}
