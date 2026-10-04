import { AppNavigationService } from './services/ui/app-navigation.service';
import { ChangeDetectionStrategy, Component, effect, inject, OnInit, signal } from '@angular/core';
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
import { AppLifecycleService } from 'src/app/services/infrastructure/system/app-lifecycle.service';
import { isHeadlessMode } from './services/infrastructure/platform/api-client.service';
import { SseClientService } from './services/infrastructure/platform/sse-client.service';
import { AndroidShareService } from './services/ui/android-share.service';
import { AndroidKeepAliveService } from './services/infrastructure/platform/android-keep-alive.service';
import { VaultService } from './services/security/vault.service';
import { VaultLockScreenComponent } from './features/components/vault-lock-screen/vault-lock-screen.component';
import { FlowContainerComponent } from './flow/flow-container.component';
import { FlowOverlayService } from 'src/app/services/ui/flow-overlay.service';
import { MainUiOverlayService } from 'src/app/services/ui/main-ui-overlay.service';

import { OpenerService } from 'src/app/services/infrastructure/platform/opener.service';

import { UiStateService } from 'src/app/services/ui/state/ui-state.service';
import { MainView } from '@app/types';

import { MainUiContainerComponent } from './layout/main-ui-container.component';
import { OverlayContainer } from '@angular/cdk/overlay';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDialog } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { ShortcutHandlerDirective } from './shared/directives/shortcut-handler.directive';

@Component({
  selector: 'app-root',
  imports: [
    MainUiContainerComponent,
    OnboardingComponent,
    NautilusComponent,
    FlowContainerComponent,
    VaultLockScreenComponent,
    NgComponentOutlet,
    ShortcutHandlerDirective,
    MatButtonModule,
    MatIconModule,
    TranslatePipe,
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
  private readonly androidShareService = inject(AndroidShareService);
  private readonly androidKeepAliveService = inject(AndroidKeepAliveService);
  protected readonly vaultService = inject(VaultService);

  private readonly navigation = inject(AppNavigationService);

  readonly selectedMainView = this.uiStateService.selectedMainView;
  readonly completedOnboarding = this.onboardingStateService.isCompleted;

  private readonly overlayContainer = inject(OverlayContainer);
  private readonly snackBar = inject(MatSnackBar);
  private readonly dialogs = inject(MatDialog);
  private appInitializing = false;
  private appInitialized = false;

  constructor() {
    inject(IconService);
    inject(DebugService);
    inject(AppLifecycleService).initialize();
    inject(OpenerService).initializeGlobalLinkInterceptor();

    this.loadingService.bindToShutdownEvents();
    this.connectSseIfHeadless();

    // Start listening for Android share intents (no-op on desktop/web).
    this.androidShareService.initialize();
    this.androidKeepAliveService.initialize();

    // Wire overlay signals into UiStateService for mobile-sidebar computation.
    this.uiStateService.setOverlaySignals({
      mainOverlay: this.mainUiOverlayService.isMainUiOverlayOpen,
      flowOverlay: this.flowOverlayService.isFlowOverlayOpen,
      nautilusOverlay: this.nautilusService.isBrowserOverlayOpen,
    });
    this.setupDefaultViewListener();
    this.dialogs.afterOpened.pipe(takeUntilDestroyed()).subscribe(ref => {
      if (!this.vaultService.isAccessible()) ref.close();
    });
    effect(() => {
      const accessible = this.vaultService.isAccessible();
      // CDK portals live outside app-root, including menus and closing animations.
      const container = this.overlayContainer.getContainerElement();
      container.style.display = accessible ? '' : 'none';
      container.inert = !accessible;
      if (!accessible) {
        this.snackBar.dismiss();
        this.dialogs.closeAll();
        return;
      }
      if (
        this.vaultService.isStatusKnown() &&
        !this.vaultService.isVaultLocked() &&
        !this.appInitialized
      ) {
        void this.initializeApp();
      }
    });
  }

  ngOnInit(): void {
    this.initializeApp().catch(error => {
      console.error('Error during app initialization:', error);
      this.initializing.set(false);
    });
  }

  protected async retryInit(): Promise<void> {
    await this.initializeApp();
  }

  private async initializeApp(): Promise<void> {
    if (this.appInitializing) return;
    this.appInitializing = true;
    try {
      this.initializing.set(true);
      await this.vaultService.checkVaultStatus();
      if (!this.vaultService.isStatusKnown()) {
        return;
      }
      if (this.vaultService.isVaultLocked() || this.appInitialized) return;

      await this.appSettingsService.loadSettings();
      await this.appSettingsService.applySavedLanguage();
      void this.appUpdaterService.initialize();
      void this.rcloneUpdateService.initialize();
      this.nautilusService.initializeFromUrl();

      if (this.modalService.isDialogStandalone()) {
        await this.modalService.resolveDialogWindow();
      } else if (
        !this.nautilusService.isStandaloneWindow() &&
        !this.flowOverlayService.isStandaloneWindow() &&
        !this.mainUiOverlayService.isStandaloneWindow()
      ) {
        this.backendService.runStartupChecks();
        await this.applyDefaultView();
      }
      this.appInitialized = true;
    } catch (error) {
      console.error('App initialization failed:', error);
    } finally {
      if (!this.modalService.isDialogStandalone() && this.appInitialized) {
        const standalone = this.nautilusService.isStandaloneWindow()
          ? 'nautilus'
          : this.flowOverlayService.isStandaloneWindow()
            ? 'flow'
            : this.mainUiOverlayService.isStandaloneWindow()
              ? 'main_menu'
              : null;
        this.navigation.initialize(standalone);
      }
      this.initializing.set(false);
      this.appInitializing = false;
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

        if (
          this.nautilusService.targetPath() ||
          this.nautilusService.selectedNautilusRemote() ||
          this.androidShareService.pendingSharedPaths().length > 0
        ) {
          return;
        }

        const view = String(setting.value) as MainView;
        if (view !== 'nautilus' && view !== 'flow' && view !== 'main_menu') return;

        this.uiStateService.setDefaultView(view);
      });
  }

  private async applyDefaultView(): Promise<void> {
    if (
      this.nautilusService.targetPath() ||
      this.nautilusService.selectedNautilusRemote() ||
      this.androidShareService.pendingSharedPaths().length > 0
    ) {
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
