import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, combineLatest } from 'rxjs';
import { map } from 'rxjs/operators';

export interface UpdateState {
  isSupported: boolean;
  buildType: string | null;
  hasUpdates: boolean;
  isUpdateInProgress: boolean;
}

/**
 * Centralized service for managing update-related state across the application
 * Provides a single source of truth for update availability and build information
 */
@Injectable({
  providedIn: 'root',
})
export class UpdateStateService {
  private buildTypeSubject = new BehaviorSubject<string | null>(null);
  private updatesDisabledSubject = new BehaviorSubject<boolean>(false);
  private hasUpdatesSubject = new BehaviorSubject<boolean>(false);
  private updateInProgressSubject = new BehaviorSubject<boolean>(false);

  public buildType$ = this.buildTypeSubject.asObservable();
  public updatesDisabled$ = this.updatesDisabledSubject.asObservable();
  public hasUpdates$ = this.hasUpdatesSubject.asObservable();
  public updateInProgress$ = this.updateInProgressSubject.asObservable();

  /**
   * Combined state observable that provides all update-related information
   */
  public updateState$: Observable<UpdateState> = combineLatest([
    this.buildType$,
    this.updatesDisabled$,
    this.hasUpdates$,
    this.updateInProgress$,
  ]).pipe(
    map(([buildType, updatesDisabled, hasUpdates, updateInProgress]) => ({
      isSupported: !updatesDisabled,
      buildType,
      hasUpdates: hasUpdates && !updatesDisabled,
      isUpdateInProgress: updateInProgress && !updatesDisabled,
    }))
  );

  setBuildType(buildType: string | null): void {
    this.buildTypeSubject.next(buildType);
  }

  setUpdatesDisabled(disabled: boolean): void {
    this.updatesDisabledSubject.next(disabled);
  }

  setHasUpdates(hasUpdates: boolean): void {
    this.hasUpdatesSubject.next(hasUpdates);
  }

  setUpdateInProgress(inProgress: boolean): void {
    this.updateInProgressSubject.next(inProgress);
  }

  getBuildType(): string | null {
    return this.buildTypeSubject.value;
  }

  areUpdatesDisabled(): boolean {
    return this.updatesDisabledSubject.value;
  }

  hasAvailableUpdates(): boolean {
    return this.hasUpdatesSubject.value && !this.updatesDisabledSubject.value;
  }

  isUpdateInProgress(): boolean {
    return this.updateInProgressSubject.value && !this.updatesDisabledSubject.value;
  }
}
