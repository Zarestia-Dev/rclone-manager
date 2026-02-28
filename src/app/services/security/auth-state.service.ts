import { inject, Injectable, signal } from '@angular/core';
import { filter, firstValueFrom, take } from 'rxjs';
import { toObservable } from '@angular/core/rxjs-interop';
import { RemoteManagementService } from '../../services/remote/remote-management.service';

/**
 * Service for managing OAuth authentication state
 * Handles authentication lifecycle and cleanup
 */
@Injectable({
  providedIn: 'root',
})
export class AuthStateService {
  // Authentication state
  // Authentication state
  private readonly _isAuthInProgress = signal<boolean>(false);
  private readonly _currentRemoteName = signal<string | null>(null);
  private readonly _isAuthCancelled = signal<boolean>(false);
  private readonly _isEditMode = signal<boolean>(false);
  private readonly _cleanupInProgress = signal<boolean>(false);

  // Public readonly signals
  public readonly isAuthInProgress = this._isAuthInProgress.asReadonly();
  public readonly isAuthCancelled = this._isAuthCancelled.asReadonly();
  public readonly currentRemoteName = this._currentRemoteName.asReadonly();
  public readonly cleanupInProgress = this._cleanupInProgress.asReadonly();

  // Public observables for backward compatibility
  public readonly isAuthInProgress$ = toObservable(this._isAuthInProgress);
  public readonly isAuthCancelled$ = toObservable(this._isAuthCancelled);
  public readonly currentRemoteName$ = toObservable(this._currentRemoteName);
  public readonly cleanupInProgress$ = toObservable(this._cleanupInProgress);

  private remoteManagementService = inject(RemoteManagementService);

  /**
   * Start authentication process
   */
  async startAuth(remoteName: string, isEditMode: boolean): Promise<void> {
    if (this._cleanupInProgress()) {
      console.debug('Waiting for previous cleanup to complete');
      await firstValueFrom(
        this.cleanupInProgress$.pipe(
          filter(inProgress => !inProgress),
          take(1)
        )
      );
    }

    this._isAuthInProgress.set(true);
    this._currentRemoteName.set(remoteName);
    this._isAuthCancelled.set(false);
    this._isEditMode.set(isEditMode);

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

      await this.remoteManagementService.quitOAuth();

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
    console.debug('Auth state reset');
  }

  /**
   * Get current authentication values
   */
  getCurrentAuthState(): {
    isInProgress: boolean;
    remoteName: string | null;
    isCancelled: boolean;
    isEditMode: boolean;
    cleanupInProgress: boolean;
  } {
    return {
      isInProgress: this._isAuthInProgress(),
      remoteName: this._currentRemoteName(),
      isCancelled: this._isAuthCancelled(),
      isEditMode: this._isEditMode(),
      cleanupInProgress: this._cleanupInProgress(),
    };
  }
}
