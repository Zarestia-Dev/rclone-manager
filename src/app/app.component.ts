import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { OnboardingComponent } from './features/onboarding/onboarding.component';
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
import { AndroidShareService } from './services/ui/android-share.service';
import { FlowContainerComponent } from './features/flow/flow-container.component';
import { FlowOverlayService } from 'src/app/services/ui/flow-overlay.service';
import { MainUiOverlayService } from 'src/app/services/ui/main-ui-overlay.service';

import { UiStateService } from 'src/app/services/ui/state/ui-state.service';
import { MainView } from '@app/types';

import { MainUiContainerComponent } from './layout/main-ui-container.component';
import { ShortcutHandlerDirective } from './shared/directives/shortcut-handler.directive';

@Component({
  selector: 'app-root',
  imports: [
    MainUiContainerComponent,
    OnboardingComponent,
    NautilusComponent,
    FlowContainerComponent,
    NgComponentOutlet,
    ShortcutHandlerDirective,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent implements OnInit {
  readonly initializing = signal(true);

  protected readonly modalService = inject(ModalService);
  protected readonly nautilusService = inject(NautilusService);
  protected readonly flowOverlayService = inject(FlowOverlayService);
  protected readonly mainUiOverlayService = inject(MainUiOverlayService);
  protected readonly uiStateService = inject(UiStateService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly onboardingStateService = inject(OnboardingStateService);
  private readonly backendService = inject(BackendService);
  private readonly sseClient = inject(SseClientService);
  private readonly loadingService = inject(GlobalLoadingService);
  private readonly appUpdaterService = inject(AppUpdaterService);
  private readonly rcloneUpdateService = inject(RcloneUpdateService);

  readonly selectedMainView = this.uiStateService.selectedMainView;
  readonly completedOnboarding = this.onboardingStateService.isCompleted;

  constructor() {
    inject(IconService);
    inject(DebugService);

    this.loadingService.bindToShutdownEvents();
    this.connectSseIfHeadless();

    // Start listening for Android share intents (no-op on desktop/web).
    inject(AndroidShareService).initialize();

    this.setupDefaultViewListener();
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
      } else if (
        !this.nautilusService.isStandaloneWindow() &&
        !this.flowOverlayService.isStandaloneWindow() &&
        !this.mainUiOverlayService.isStandaloneWindow()
      ) {
        this.backendService.runStartupChecks();
        void this.appUpdaterService.initialize();
        void this.rcloneUpdateService.initialize();
        await this.applyDefaultView();
      }
    } catch (error) {
      console.error('App initialization failed:', error);
    } finally {
      this.initializing.set(false);
    }
  }

  private setupDefaultViewListener(): void {
    this.appSettingsService
      .selectSetting('general.default_view')
      .pipe(takeUntilDestroyed())
      .subscribe(setting => {
        if (!setting?.value) return;

        if (
          this.nautilusService.isStandaloneWindow() ||
          this.flowOverlayService.isStandaloneWindow() ||
          this.mainUiOverlayService.isStandaloneWindow()
        ) {
          return;
        }

        if (this.nautilusService.targetPath() || this.nautilusService.selectedNautilusRemote()) {
          return;
        }

        const view = String(setting.value) as MainView;
        if (view !== 'nautilus' && view !== 'flow' && view !== 'main_menu') return;

        this.nautilusService.closeBrowserOverlay();
        this.flowOverlayService.closeFlowOverlay();
        this.mainUiOverlayService.closeMainUiOverlay();
        this.uiStateService.setDefaultView(view);
      });
  }

  private async applyDefaultView(): Promise<void> {
    if (this.nautilusService.targetPath() || this.nautilusService.selectedNautilusRemote()) {
      return;
    }

    const defaultView =
      await this.appSettingsService.getSettingValue<string>('general.default_view');
    if (defaultView === 'nautilus' || defaultView === 'flow' || defaultView === 'main_menu') {
      this.uiStateService.setDefaultView(defaultView as MainView);
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
      await this.applyDefaultView();
    } catch (error) {
      console.error('Error saving onboarding status:', error);
      throw error;
    }
  }
}
