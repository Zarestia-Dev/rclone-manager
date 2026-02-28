import { Injectable, signal, Signal } from '@angular/core';
import { LoadingStates, PasswordManagerState } from '@app/types';
import { Observable } from 'rxjs';
import { toObservable } from '@angular/core/rxjs-interop';

@Injectable()
export class PasswordManagerStateService {
  private readonly _state = signal<PasswordManagerState>({
    hasStoredPassword: false,
    hasEnvPassword: false,
    isConfigEncrypted: false,
    loading: this.createInitialLoadingState(),
    errors: [],
  });

  get state(): PasswordManagerState {
    return this._state();
  }

  get stateSignal(): Signal<PasswordManagerState> {
    return this._state.asReadonly();
  }

  get state$(): Observable<PasswordManagerState> {
    return toObservable(this._state);
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
    this._state.update(state => ({ ...state, ...updates }));
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
