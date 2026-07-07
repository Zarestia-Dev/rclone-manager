import { DestroyRef, Injectable, inject, signal, effect, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AppSettingsService } from '../../settings/app-settings.service';
import { SystemHealthService } from 'src/app/services/infrastructure/maintenance/system-health.service';

/**
 * Single source of truth for onboarding completion status.
 */
@Injectable({ providedIn: 'root' })
export class OnboardingStateService {
  private appSettingsService = inject(AppSettingsService);
  private systemHealthService = inject(SystemHealthService);
  private destroyRef = inject(DestroyRef);

  private readonly _isCompleted = signal<boolean>(false);
  private readonly _isInitialized = signal<boolean>(false);

  public readonly isCompleted = this._isCompleted.asReadonly();
  public readonly isInitialized = this._isInitialized.asReadonly();

  constructor() {
    this.appSettingsService
      .selectSetting('core.completed_onboarding')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: setting => {
          const completed = setting?.value === true;
          this._isCompleted.set(completed);
          this.systemHealthService.setOnboardingCompleted(completed);
          this._isInitialized.set(true);
        },
        error: error => {
          console.error('Error in onboarding settings stream:', error);
          this._isCompleted.set(false);
          this.systemHealthService.setOnboardingCompleted(false);
          this._isInitialized.set(true);
        },
      });

    this.setupPostOnboardingTasks();
  }

  isOnboardingActive(): boolean {
    return !this._isCompleted();
  }

  isOnboardingCompleted(): boolean {
    return this._isCompleted();
  }

  getOnboardingStatus(): boolean {
    return this.isCompleted();
  }

  isInitializedSnapshot(): boolean {
    return this._isInitialized();
  }

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
   * Force update the onboarding state without persisting to settings.
   * Useful for immediate UI updates before async operations complete.
   */
  setOnboardingState(completed: boolean): void {
    this._isCompleted.set(completed);
    this.systemHealthService.setOnboardingCompleted(completed);
  }

  private setupPostOnboardingTasks(): void {
    effect(() => {
      if (this.isCompleted()) {
        untracked(() => {
          this.runPostOnboardingSetup().catch(error => {
            console.error('Failed to run post-onboarding setup:', error);
          });
        });
      }
    });
  }

  private async runPostOnboardingSetup(): Promise<void> {
    await this.systemHealthService.checkMountPluginAndPromptRepair();
  }
}
