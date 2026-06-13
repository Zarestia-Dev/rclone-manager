import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { NgComponentOutlet } from '@angular/common';

import { TitlebarComponent } from './layout/titlebar/titlebar.component';
import { OnboardingComponent } from './features/onboarding/onboarding.component';
import { HomeComponent } from './home/home.component';
import { TabsButtonsComponent } from './layout/tabs-buttons/tabs-buttons.component';
import { ShortcutHandlerDirective } from './shared/directives/shortcut-handler.directive';
import { BannerComponent } from './layout/banners/banner.component';
import { NautilusComponent } from './file-browser/nautilus/nautilus.component';

// Services
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { OnboardingStateService } from 'src/app/services/ui/state/onboarding-state.service';
import { NautilusService } from 'src/app/services/ui/nautilus.service';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { DebugService } from 'src/app/services/infrastructure/system/debug.service';
import { GlobalLoadingService } from 'src/app/services/ui/global-loading.service';
import { ModalService } from 'src/app/services/ui/modal.service';
import { AppUpdaterService } from 'src/app/services/infrastructure/maintenance/app-updater.service';
import { RcloneUpdateService } from 'src/app/services/infrastructure/maintenance/rclone-update.service';
import { isHeadlessMode } from './services/infrastructure/platform/api-client.service';
import { SseClientService } from './services/infrastructure/platform/sse-client.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    TitlebarComponent,
    OnboardingComponent,
    TabsButtonsComponent,
    HomeComponent,
    ShortcutHandlerDirective,
    BannerComponent,
    NautilusComponent,
    NgComponentOutlet,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent implements OnInit {
  readonly initializing = signal(true);

  protected readonly modalService = inject(ModalService);
  protected readonly nautilusService = inject(NautilusService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly onboardingStateService = inject(OnboardingStateService);
  private readonly backendService = inject(BackendService);
  private readonly sseClient = inject(SseClientService);
  private readonly loadingService = inject(GlobalLoadingService);
  private readonly appUpdaterService = inject(AppUpdaterService);
  private readonly rcloneUpdateService = inject(RcloneUpdateService);

  readonly completedOnboarding = this.onboardingStateService.isCompleted;

  constructor() {
    inject(IconService);
    inject(DebugService);

    this.loadingService.bindToShutdownEvents();
    this.connectSseIfHeadless();
  }

  ngOnInit(): void {
    this.initializeApp().catch(error => {
      console.error('Error during app initialization:', error);
      this.initializing.set(false);
    });
  }

  private async initializeApp(): Promise<void> {
    try {
      await this.appSettingsService.loadSettings();
      await this.appSettingsService.applySavedLanguage();
      this.nautilusService.openFromBrowseQueryParam();

      if (this.modalService.isDialogStandalone()) {
        await this.modalService.resolveDialogWindow();
      } else if (!this.nautilusService.isStandaloneWindow()) {
        this.backendService.runStartupChecks();
        void this.appUpdaterService.initialize();
        void this.rcloneUpdateService.initialize();
      }
    } catch (error) {
      console.error('App initialization failed:', error);
    } finally {
      this.initializing.set(false);
    }
  }

  private connectSseIfHeadless(): void {
    if (isHeadlessMode()) {
      this.sseClient.connect();
    }
  }

  async finishOnboarding(): Promise<void> {
    try {
      await this.onboardingStateService.completeOnboarding();
    } catch (error) {
      console.error('Error saving onboarding status:', error);
      throw error;
    }
  }
}
