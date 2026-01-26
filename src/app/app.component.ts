import { Component, inject, OnDestroy, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Subject, takeUntil } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { TitlebarComponent } from './layout/titlebar/titlebar.component';
import { OnboardingComponent } from './features/onboarding/onboarding.component';
import { HomeComponent } from './home/home.component';
import { MatBottomSheetModule } from '@angular/material/bottom-sheet';
import { TabsButtonsComponent } from './layout/tabs-buttons/tabs-buttons.component';
import { AppTab, RepairSheetType } from '@app/types';
import { ShortcutHandlerDirective } from './shared/directives/shortcut-handler.directive';
import { BannerComponent } from './layout/banners/banner.component';

// Services
import {
  UiStateService,
  AppSettingsService,
  EventListenersService,
  OnboardingStateService,
  RcloneUpdateService,
  AppUpdaterService,
  NautilusService,
  SystemHealthService,
  BackendService,
} from '@app/services';
import { GlobalLoadingService } from './services/ui/global-loading.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    TitlebarComponent,
    OnboardingComponent,
    MatBottomSheetModule,
    TabsButtonsComponent,
    HomeComponent,
    ShortcutHandlerDirective,
    BannerComponent,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnDestroy {
  // --- STATE SIGNALS ---
  readonly completedOnboarding = signal(false);
  readonly alreadyReported = signal(false);

  // --- INJECTED DEPENDENCIES & SERVICES ---
  readonly uiStateService = inject(UiStateService);
  readonly appSettingsService = inject(AppSettingsService);
  private readonly eventListenersService = inject(EventListenersService);
  readonly onboardingStateService = inject(OnboardingStateService);
  private readonly appUpdaterService = inject(AppUpdaterService);
  private readonly rcloneUpdateService = inject(RcloneUpdateService);
  private readonly loadingService = inject(GlobalLoadingService);
  private readonly nautilusService = inject(NautilusService);
  private readonly systemHealthService = inject(SystemHealthService);
  private readonly backendService = inject(BackendService);
  private readonly translateService = inject(TranslateService);

  // --- DERIVED STATE & OBSERVABLE CONVERSIONS ---
  readonly currentTab = toSignal(this.uiStateService.currentTab$, {
    initialValue: 'general' as AppTab,
  });

  // --- PRIVATE PROPERTIES ---
  private readonly destroy$ = new Subject<void>();

  constructor() {
    this.initializeApp().catch(error => {
      console.error('Error during app initialization:', error);
    });
    this.setupSubscriptions();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private async initializeApp(): Promise<void> {
    try {
      await this.appSettingsService.loadSettings();

      // Initialize language from settings
      const savedLang =
        (await this.appSettingsService.getSettingValue<string>('general.language')) || 'en-US';
      this.translateService.use(savedLang);

      await this.checkOnboardingStatus();
      this.checkBrowseUrlParameter();

      // Perform startup/background checks
      this.runBackendChecks();
    } catch (error) {
      console.error('App initialization failed:', error);
      this.completedOnboarding.set(false);
    }
  }

  private runBackendChecks(): void {
    // These run in background without blocking init
    this.backendService.loadBackends().then(async () => {
      await this.backendService.checkStartupConnectivity();
      await this.backendService.checkAllBackends();
    });
  }

  /**
   * Check for ?browse=remoteName URL parameter and open in-app browser
   * This is triggered from the tray menu when "Browse (In App)" is clicked
   */
  private checkBrowseUrlParameter(): void {
    const urlParams = new URLSearchParams(window.location.search);
    const browseRemote = urlParams.get('browse');

    if (browseRemote) {
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, '', cleanUrl);
      // Skip entrance animation when opening via deep link
      this.nautilusService.openForRemote(browseRemote, false);
    }
  }

  private setupSubscriptions(): void {
    this.setupRcloneEngineListener();
    this.listenToAppEvents();
    this.listenToBrowseInAppEvent();
  }

  private setupRcloneEngineListener(): void {
    // Listen to rclone engine ready events
    this.eventListenersService
      .listenToRcloneEngineReady()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => this.handleRcloneReady(),
        error: error => console.error('Rclone engine ready subscription error:', error),
      });

    // Listen to rclone engine path error events
    this.eventListenersService
      .listenToRcloneEnginePathError()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          if (this.completedOnboarding()) {
            this.systemHealthService.handleRclonePathError(this.alreadyReported());
            this.alreadyReported.set(true);
          }
        },
        error: error => console.error('Rclone engine path error subscription error:', error),
      });

    // Listen to rclone engine password error events
    this.eventListenersService
      .listenToRcloneEnginePasswordError()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: async () => {
          if (this.completedOnboarding()) {
            // Only skip if password is already unlocked (sheet should appear when password is needed)
            if (!this.systemHealthService.passwordUnlocked()) {
              await this.systemHealthService.handlePasswordRequired(false);
            }
          }
        },
        error: error => console.error('Rclone engine password error subscription error:', error),
      });
  }

  private listenToAppEvents(): void {
    this.eventListenersService.listenToAppEvents().subscribe({
      next: event => {
        if (typeof event === 'object' && event?.status === 'shutting_down') {
          this.loadingService.show({
            title: this.translateService.instant('app.shutdown.title'),
            message: this.translateService.instant('app.shutdown.message'),
            icon: 'refresh',
          });
        }

        if (typeof event === 'object' && event?.status === 'language_changed') {
          const lang = event.language as string;
          if (lang && lang !== this.translateService.getCurrentLang()) {
            this.translateService.use(lang);
          }
        }
      },
    });
  }

  /**
   * Listen for browse-in-app events from tray menu
   * This is used when the window is already open to avoid page reload
   */
  private listenToBrowseInAppEvent(): void {
    this.eventListenersService
      .listenToOpenInternalRoute()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (remoteName: string) => {
          console.debug(`📂 Browse event received for remote: ${remoteName}`);
          this.nautilusService.openForRemote(remoteName);
        },
        error: error => console.error('Browse in app event error:', error),
      });
  }

  private async checkOnboardingStatus(): Promise<void> {
    this.onboardingStateService.onboardingCompleted$
      .pipe(takeUntil(this.destroy$))
      .subscribe(async completed => {
        this.completedOnboarding.set(completed);
        if (completed) {
          await this.postOnboardingSetup();
        }
      });
  }

  private async postOnboardingSetup(): Promise<void> {
    await this.checkMountPluginStatus();
    await this.runAutoUpdateChecks();
  }

  private async checkMountPluginStatus(): Promise<void> {
    try {
      // Use SystemHealthService for consistent state
      const mountPluginOk = await this.systemHealthService.checkMountPlugin();
      console.debug('Mount plugin status: ', mountPluginOk);

      if (mountPluginOk === false) {
        await this.systemHealthService.showRepairSheet({
          type: RepairSheetType.MOUNT_PLUGIN,
          title: 'Mount Plugin Problem',
          message:
            'The mount plugin could not be found or started. You can reinstall or repair it now.',
        });

        // Delegate listener setup to the service
        this.systemHealthService.setupMountPluginListener();
      }
    } catch (error) {
      console.error('Error checking mount plugin status:', error);
    }
  }

  private async runAutoUpdateChecks(): Promise<void> {
    try {
      // Just initialize the services; they will auto-check if enabled
      await this.appUpdaterService.initialize();
      await this.rcloneUpdateService.initialize();
    } catch (error) {
      console.error('Failed to run auto-update checks post-onboarding:', error);
    }
  }

  //#region Rclone Error Handling
  private handleRcloneReady(): void {
    this.alreadyReported.set(false);
    this.systemHealthService.closeSheetsByTypes([
      RepairSheetType.RCLONE_PATH,
      RepairSheetType.RCLONE_PASSWORD,
    ]);
  }
  //#endregion

  async finishOnboarding(): Promise<void> {
    try {
      // Use the centralized service to complete onboarding
      await this.onboardingStateService.completeOnboarding();
      this.completedOnboarding.set(true);
      console.debug('Onboarding completed via OnboardingStateService');

      await this.postOnboardingSetup();
    } catch (error) {
      console.error('Error saving onboarding status:', error);
      this.completedOnboarding.set(false);
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
