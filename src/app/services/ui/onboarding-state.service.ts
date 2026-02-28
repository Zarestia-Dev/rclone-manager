import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { AppSettingsService } from '../settings/app-settings.service';
import { AppUpdaterService } from '../system/app-updater.service';
import { RcloneUpdateService } from '../system/rclone-update.service';
import { SystemHealthService } from '../system/system-health.service';
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
  private systemHealthService = inject(SystemHealthService);
  private appUpdaterService = inject(AppUpdaterService);
  private rcloneUpdateService = inject(RcloneUpdateService);
  private destroyRef = inject(DestroyRef);

  // State tracking
  private readonly _isCompleted = signal<boolean>(false);
  private readonly _isInitialized = signal<boolean>(false);

  // Public readonly signals
  public readonly isCompleted = this._isCompleted.asReadonly();
  public readonly isInitialized = this._isInitialized.asReadonly();

  constructor() {
    this.initializeOnboardingState().catch(error => {
      console.error('Failed to initialize onboarding state:', error);
    });

    this.setupPostOnboardingTasks();
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

      this._isCompleted.set(completed);
      this.systemHealthService.setOnboardingCompleted(completed);
      this._isInitialized.set(true);
    } catch (error) {
      console.error('Error initializing onboarding state:', error);
      this._isCompleted.set(false);
      this.systemHealthService.setOnboardingCompleted(false);
      this._isInitialized.set(true);
    }
  }

  /**
   * Check if onboarding is currently active (not completed)
   * Synchronous check using current state
   */
  isOnboardingActive(): boolean {
    return !this._isCompleted();
  }

  /**
   * Check if onboarding has been completed
   * Synchronous check using current state
   */
  isOnboardingCompleted(): boolean {
    return this._isCompleted();
  }

  /**
   * Get current onboarding completion status
   */
  getOnboardingStatus(): boolean {
    return this.isCompleted();
  }

  /**
   * Check if the service has been initialized with settings data
   */
  isInitializedSnapshot(): boolean {
    return this._isInitialized();
  }

  /**
   * Mark onboarding as completed and save to settings
   * This should be called when user finishes onboarding
   */
  async completeOnboarding(): Promise<void> {
    try {
      await this.appSettingsService.saveSetting('core', 'completed_onboarding', true);
      this._isCompleted.set(true);
      this.systemHealthService.setOnboardingCompleted(true);
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
      this._isCompleted.set(false);
      this.systemHealthService.setOnboardingCompleted(false);
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
    this._isCompleted.set(completed);
    this.systemHealthService.setOnboardingCompleted(completed);
  }

  private setupPostOnboardingTasks(): void {
    import('@angular/core').then(({ effect, untracked }) => {
      effect(() => {
        if (this.isCompleted()) {
          untracked(() => {
            this.runPostOnboardingSetup().catch(error => {
              console.error('Failed to run post-onboarding setup:', error);
            });
          });
        }
      });
    });
  }

  private async runPostOnboardingSetup(): Promise<void> {
    await this.systemHealthService.checkMountPluginAndPromptRepair();
    await this.appUpdaterService.initialize();
    await this.rcloneUpdateService.initialize();
  }
}
