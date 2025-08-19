import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

interface PasswordLockoutStatus {
  is_locked: boolean;
  failed_attempts: number;
  max_attempts: number;
  remaining_lockout_time?: number;
}

interface LoadingStates {
  isValidating: boolean;
  isEncrypting: boolean;
  isUnencrypting: boolean;
  isChangingPassword: boolean;
  isStoringPassword: boolean;
  isRemovingPassword: boolean;
  isSettingEnv: boolean;
  isClearingEnv: boolean;
  isResettingLockout: boolean;
}

interface PasswordManagerState {
  hasStoredPassword: boolean;
  hasEnvPassword: boolean;
  isConfigEncrypted: boolean;
  lockoutStatus: PasswordLockoutStatus | null;
  loading: LoadingStates;
  errors: string[];
}

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
