import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { TitlebarComponent } from './layout/titlebar/titlebar.component';
import { OnboardingComponent } from './features/onboarding/onboarding.component';
import { HomeComponent } from './home/home.component';
import { TabsButtonsComponent } from './layout/tabs-buttons/tabs-buttons.component';
import { ShortcutHandlerDirective } from '@app/directives';
import { BannerComponent } from './layout/banners/banner.component';
import { NautilusComponent } from './file-browser/nautilus/nautilus.component';

// Services
import {
  AppSettingsService,
  OnboardingStateService,
  NautilusService,
  BackendService,
  IconService,
  DebugService,
  GlobalLoadingService,
} from '@app/services';
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
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent implements OnInit {
  readonly initializing = signal(true);

  protected readonly nautilusService = inject(NautilusService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly onboardingStateService = inject(OnboardingStateService);
  private readonly backendService = inject(BackendService);
  private readonly sseClient = inject(SseClientService);
  private readonly loadingService = inject(GlobalLoadingService);

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

      if (!this.nautilusService.isStandaloneWindow()) {
        this.backendService.runStartupChecks();
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
