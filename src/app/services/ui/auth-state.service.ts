import { Injectable } from '@angular/core';
import { BehaviorSubject, filter, firstValueFrom, take } from 'rxjs';
import { RemoteManagementService } from '../features/remote-management.service';

/**
 * Service for managing OAuth authentication state
 * Handles authentication lifecycle and cleanup
 */
@Injectable({
  providedIn: 'root'
})
export class AuthStateService {

  // Authentication state
  private _isAuthInProgress$ = new BehaviorSubject<boolean>(false);
  private _currentRemoteName$ = new BehaviorSubject<string | null>(null);
  private _isAuthCancelled$ = new BehaviorSubject<boolean>(false);
  private _isEditMode$ = new BehaviorSubject<boolean>(false);
  private _cleanupInProgress$ = new BehaviorSubject<boolean>(false);

  // Public observables
  public isAuthInProgress$ = this._isAuthInProgress$.asObservable();
  public isAuthCancelled$ = this._isAuthCancelled$.asObservable();
  public currentRemoteName$ = this._currentRemoteName$.asObservable();
  public cleanupInProgress$ = this._cleanupInProgress$.asObservable();

  constructor(private remoteManagementService: RemoteManagementService) {}

  /**
   * Start authentication process
   */
  async startAuth(remoteName: string, isEditMode: boolean): Promise<void> {
    if (this._cleanupInProgress$.value) {
      console.log('Waiting for previous cleanup to complete');
      await firstValueFrom(
        this._cleanupInProgress$.pipe(
          filter((inProgress) => !inProgress),
          take(1)
        )
      );
    }

    this._isAuthInProgress$.next(true);
    this._currentRemoteName$.next(remoteName);
    this._isAuthCancelled$.next(false);
    this._isEditMode$.next(isEditMode);
    
    console.log(
      'Starting auth for remote:',
      remoteName,
      'in edit mode:',
      isEditMode
    );
  }

  /**
   * Cancel authentication process
   */
  async cancelAuth(): Promise<void> {
    if (this._cleanupInProgress$.value) {
      console.log('Cleanup already in progress');
      return;
    }

    this._cleanupInProgress$.next(true);
    
    try {
      this._isAuthCancelled$.next(true);
      const remoteName = this._currentRemoteName$.value;
      const isEditMode = this._isEditMode$.value;
      
      console.log(
        'Cancelling auth for remote:',
        remoteName,
        'in edit mode:',
        isEditMode
      );

      await this.remoteManagementService.quitOAuth();

      // Delete remote if it's not in edit mode
      if (remoteName && !isEditMode) {
        console.log('Deleting remote:', remoteName);
        try {
          await this.remoteManagementService.deleteRemote(remoteName);
        } catch (error) {
          console.error('Error deleting remote:', error);
        }
      }
    } finally {
      this.resetAuthState();
      this._cleanupInProgress$.next(false);
    }
  }

  /**
   * Reset authentication state
   */
  resetAuthState(): void {
    this._isAuthInProgress$.next(false);
    this._currentRemoteName$.next(null);
    this._isAuthCancelled$.next(false);
    this._isEditMode$.next(false);
    console.log('Auth state reset');
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
      isInProgress: this._isAuthInProgress$.value,
      remoteName: this._currentRemoteName$.value,
      isCancelled: this._isAuthCancelled$.value,
      isEditMode: this._isEditMode$.value,
      cleanupInProgress: this._cleanupInProgress$.value
    };
  }
}
