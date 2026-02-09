import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TitlebarComponent } from './layout/titlebar/titlebar.component';
import { OnboardingComponent } from './features/onboarding/onboarding.component';
import { HomeComponent } from './home/home.component';
import { TabsButtonsComponent } from './layout/tabs-buttons/tabs-buttons.component';
import { AppTab } from '@app/types';
import { ShortcutHandlerDirective } from './shared/directives/shortcut-handler.directive';
import { BannerComponent } from './layout/banners/banner.component';

// Services
import {
  UiStateService,
  AppSettingsService,
  OnboardingStateService,
  NautilusService,
  BackendService,
  IconService,
} from '@app/services';
import { DebugService } from './services/system/debug.service';
import { GlobalLoadingService } from './services/ui/global-loading.service';
import { ApiClientService } from './services/core/api-client.service';
import { SseClientService } from './services/core/sse-client.service';

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
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent implements OnInit {
  // --- STATE SIGNALS ---
  readonly initializing = signal(true);

  // --- INJECTED DEPENDENCIES & SERVICES ---
  readonly uiStateService = inject(UiStateService);
  readonly appSettingsService = inject(AppSettingsService);
  readonly onboardingStateService = inject(OnboardingStateService);
  private readonly nautilusService = inject(NautilusService);
  private readonly backendService = inject(BackendService);
  private readonly iconService = inject(IconService);
  private readonly debugService = inject(DebugService);
  private readonly loadingService = inject(GlobalLoadingService);
  private readonly apiClient = inject(ApiClientService);
  private readonly sseClient = inject(SseClientService);

  // --- DERIVED STATE & OBSERVABLE CONVERSIONS ---
  readonly currentTab = toSignal(this.uiStateService.currentTab$, {
    initialValue: 'general' as AppTab,
  });

  readonly completedOnboarding = toSignal(this.onboardingStateService.onboardingCompleted$, {
    initialValue: false,
  });

  constructor() {
    this.loadingService.bindToShutdownEvents();
    void this.iconService;
    void this.debugService;
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

      // Perform startup/background checks in the background
      this.backendService.runStartupChecks();
    } catch (error) {
      console.error('App initialization failed:', error);
    } finally {
      this.initializing.set(false);
    }
  }

  private connectSseIfHeadless(): void {
    if (this.apiClient.isHeadless()) {
      this.sseClient.connect();
    }
  }

  async finishOnboarding(): Promise<void> {
    try {
      await this.onboardingStateService.completeOnboarding();
      console.debug('Onboarding completed via OnboardingStateService');
    } catch (error) {
      console.error('Error saving onboarding status:', error);
      throw error;
    }
  }

  setTab(tab: AppTab): void {
    if (this.currentTab() === tab) {
      return;
    }
    this.uiStateService.setTab(tab);
  }
}
