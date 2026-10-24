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

  private setupPostOnboardingTasks(): void {
    effect(() => {
      if (this.isCompleted()) {
        untracked(() => {
          this.systemHealthService.checkMountPluginAndPromptRepair().catch(error => {
            console.error('Failed to run post-onboarding setup:', error);
          });
        });
      }
    });
  }
}
