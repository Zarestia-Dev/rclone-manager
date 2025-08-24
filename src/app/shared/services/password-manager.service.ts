import { Injectable } from '@angular/core';
import { LoadingStates, PasswordManagerState } from '@app/types';
import { BehaviorSubject, Observable } from 'rxjs';

@Injectable()
export class PasswordManagerStateService {
  private readonly _state$ = new BehaviorSubject<PasswordManagerState>({
    hasStoredPassword: false,
    hasEnvPassword: false,
    isConfigEncrypted: false,
    lockoutStatus: null,
    loading: this.createInitialLoadingState(),
    errors: [],
  });

  get state(): PasswordManagerState {
    return this._state$.value;
  }

  get state$(): Observable<PasswordManagerState> {
    return this._state$.asObservable();
  }

  setLoading(loading: Partial<LoadingStates>): void {
    this.updateState({
      loading: { ...this.state.loading, ...loading },
    });
  }

  setError(error: string): void {
    this.updateState({
      errors: [...this.state.errors, error],
    });
  }

  updateState(updates: Partial<PasswordManagerState>): void {
    this._state$.next({ ...this.state, ...updates });
  }

  private createInitialLoadingState(): LoadingStates {
    return {
      isValidating: false,
      isEncrypting: false,
      isUnencrypting: false,
      isChangingPassword: false,
      isStoringPassword: false,
      isRemovingPassword: false,
      isSettingEnv: false,
      isClearingEnv: false,
      isResettingLockout: false,
    };
  }
}
