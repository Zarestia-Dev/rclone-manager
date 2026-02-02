import { Injectable, inject } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { AppSettingsService } from '../settings/app-settings.service';

/**
 * Centralized service for managing onboarding state across the application
 * Provides a single source of truth for onboarding completion status
 *
 * Usage:
 * - Check if onboarding is active: `onboardingState.isOnboardingActive()`
 * - Check if completed: `onboardingState.isOnboardingCompleted()`
 * - Subscribe to changes: `onboardingState.onboardingCompleted$`
 * - Complete onboarding: `await onboardingState.completeOnboarding()`
 */
@Injectable({
  providedIn: 'root',
})
export class OnboardingStateService {
  private appSettingsService = inject(AppSettingsService);

  // State tracking
  private _isCompleted$ = new BehaviorSubject<boolean>(false);
  private _isInitialized$ = new BehaviorSubject<boolean>(false);

  // Public observables
  public readonly onboardingCompleted$ = this._isCompleted$.asObservable();
  public readonly isInitialized$ = this._isInitialized$.asObservable();

  constructor() {
    this.initializeOnboardingState().catch(error => {
      console.error('Failed to initialize onboarding state:', error);
    });
  }

  /**
   * Initialize onboarding state from settings
   * Called automatically on service construction
   */
  private async initializeOnboardingState(): Promise<void> {
    try {
      const completed =
        (await this.appSettingsService.getSettingValue<boolean>('core.completed_onboarding')) ||
        false;

      this._isCompleted$.next(completed);
      this._isInitialized$.next(true);
    } catch (error) {
      console.error('Error initializing onboarding state:', error);
      this._isCompleted$.next(false);
      this._isInitialized$.next(true);
    }
  }

  /**
   * Check if onboarding is currently active (not completed)
   * Synchronous check using current state
   */
  isOnboardingActive(): boolean {
    return !this._isCompleted$.value;
  }

  /**
   * Check if onboarding has been completed
   * Synchronous check using current state
   */
  isOnboardingCompleted(): boolean {
    return this._isCompleted$.value;
  }

  /**
   * Get current onboarding completion status as observable
   */
  getOnboardingStatus(): Observable<boolean> {
    return this.onboardingCompleted$;
  }

  /**
   * Check if the service has been initialized with settings data
   */
  isInitialized(): boolean {
    return this._isInitialized$.value;
  }

  /**
   * Mark onboarding as completed and save to settings
   * This should be called when user finishes onboarding
   */
  async completeOnboarding(): Promise<void> {
    try {
      await this.appSettingsService.saveSetting('core', 'completed_onboarding', true);
      this._isCompleted$.next(true);
    } catch (error) {
      console.error('Failed to complete onboarding:', error);
      throw error;
    }
  }

  /**
   * Reset onboarding state (for testing or re-onboarding)
   * This will set onboarding as not completed
   */
  async resetOnboarding(): Promise<void> {
    try {
      await this.appSettingsService.saveSetting('core', 'completed_onboarding', false);
      this._isCompleted$.next(false);
    } catch (error) {
      console.error('Failed to reset onboarding:', error);
      throw error;
    }
  }

  /**
   * Force update the onboarding state without persisting to settings
   * Useful for immediate UI updates before async operations complete
   */
  setOnboardingState(completed: boolean): void {
    this._isCompleted$.next(completed);
  }
}
