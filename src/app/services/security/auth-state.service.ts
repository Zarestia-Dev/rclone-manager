import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RemoteManagementService } from '../../services/remote/remote-management.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { BackendService } from '../infrastructure/system/backend.service';

/**
 * Service for managing OAuth authentication state
 * Handles authentication lifecycle and cleanup
 */
@Injectable({
  providedIn: 'root',
})
export class AuthStateService {
  private readonly destroyRef = inject(DestroyRef);
  private readonly remoteManagementService = inject(RemoteManagementService);
  private readonly eventListenersService = inject(EventListenersService);
  private readonly backendService = inject(BackendService);

  // Authentication state
  private readonly _isAuthInProgress = signal<boolean>(false);
  private readonly _currentRemoteName = signal<string | null>(null);
  private readonly _isAuthCancelled = signal<boolean>(false);
  private readonly _isEditMode = signal<boolean>(false);
  private readonly _cleanupInProgress = signal<boolean>(false);
  private readonly _oauthUrl = signal<string | null>(null);

  // Public readonly signals
  public readonly isAuthInProgress = this._isAuthInProgress.asReadonly();
  public readonly isAuthCancelled = this._isAuthCancelled.asReadonly();
  public readonly oauthUrl = this._oauthUrl.asReadonly();
  public readonly isActiveBackendLocal = computed(() => {
    const activeBackend = this.backendService.activeBackend();
    if (activeBackend === 'Local') return true;
    return (
      this.backendService.backends().find(backend => backend.name === activeBackend)?.isLocal ??
      true
    );
  });
  public readonly shouldShowRemoteOAuthFallback = computed(
    () => this._isAuthInProgress() && !this.isActiveBackendLocal() && !this._oauthUrl()
  );

  constructor() {
    this.eventListenersService
      .listenToOAuthUrl()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(payload => {
        if (payload?.url) {
          this._oauthUrl.set(payload.url);
        }
      });
  }

  /**
   * Start authentication process
   */
  async startAuth(remoteName: string, isEditMode: boolean): Promise<void> {
    if (this._cleanupInProgress()) return;

    this._isAuthInProgress.set(true);
    this._currentRemoteName.set(remoteName);
    this._isAuthCancelled.set(false);
    this._isEditMode.set(isEditMode);
    this._oauthUrl.set(null);

    console.debug('Starting auth for remote:', remoteName, 'in edit mode:', isEditMode);
  }

  /**
   * Cancel authentication process
   */
  async cancelAuth(): Promise<void> {
    if (this._cleanupInProgress()) {
      console.debug('Cleanup already in progress');
      return;
    }

    this._cleanupInProgress.set(true);

    try {
      this._isAuthCancelled.set(true);
      const remoteName = this._currentRemoteName();
      const isEditMode = this._isEditMode();

      console.debug('Cancelling auth for remote:', remoteName, 'in edit mode:', isEditMode);

      if (this.isActiveBackendLocal()) {
        try {
          await this.remoteManagementService.quitOAuth();
        } catch (error) {
          console.warn('Error quitting local OAuth process:', error);
        }
      }

      // Delete remote if it's not in edit mode
      if (remoteName && !isEditMode) {
        console.debug('Deleting remote:', remoteName);
        try {
          await this.remoteManagementService.deleteRemote(remoteName);
        } catch (error) {
          console.error('Error deleting remote:', error);
        }
      }
    } finally {
      this.resetAuthState();
      this._cleanupInProgress.set(false);
    }
  }

  /**
   * Reset authentication state
   */
  resetAuthState(): void {
    this._isAuthInProgress.set(false);
    this._currentRemoteName.set(null);
    this._isAuthCancelled.set(false);
    this._isEditMode.set(false);
    this._oauthUrl.set(null);
    console.debug('Auth state reset');
  }
}
