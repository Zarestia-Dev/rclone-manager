import { Component, inject, OnInit, OnDestroy } from '@angular/core';
import { Subject, takeUntil, firstValueFrom, filter } from 'rxjs';
import { TitlebarComponent } from './layout/titlebar/titlebar.component';
import { OnboardingComponent } from './features/onboarding/onboarding.component';
import { HomeComponent } from './home/home.component';
import {
  MatBottomSheet,
  MatBottomSheetModule,
  MatBottomSheetRef,
} from '@angular/material/bottom-sheet';
import { TabsButtonsComponent } from './layout/tabs-buttons/tabs-buttons.component';
import { RepairData } from './shared/components/types';
import { AppTab, RepairSheetType } from '@app/types';
import { RepairSheetComponent } from './features/components/repair-sheet/repair-sheet.component';
import { ShortcutHandlerDirective } from './shared/directives/shortcut-handler.directive';
import { BannerComponent } from './layout/banners/banner.component';
import { PasswordPromptResult, RcloneEngineEvent } from '@app/types';

// Services
import {
  UiStateService,
  AppSettingsService,
  InstallationService,
  EventListenersService,
  RclonePasswordService,
} from '@app/services';

@Component({
  selector: 'app-root',
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
export class AppComponent implements OnInit, OnDestroy {
  completedOnboarding = false;
  alreadyReported = false;
  currentTab: AppTab = 'general';

  // Services
  private bottomSheet = inject(MatBottomSheet);
  private installationService = inject(InstallationService);
  public uiStateService = inject(UiStateService);
  public appSettingsService = inject(AppSettingsService);
  private eventListenersService = inject(EventListenersService);
  private rclonePasswordService = inject(RclonePasswordService);

  // Subscription management
  private destroy$ = new Subject<void>();
  private activeSheets = new Set<MatBottomSheetRef<RepairSheetComponent>>();
  private passwordPromptInProgress = false; // Prevent multiple password prompts

  constructor() {
    this.initializeApp().catch(error => {
      console.error('Error during app initialization:', error);
    });
  }

  ngOnInit(): void {
    this.setupSubscriptions();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.closeAllSheets();
  }

  private async initializeApp(): Promise<void> {
    try {
      await this.checkOnboardingStatus();
    } catch (error) {
      console.error('App initialization failed:', error);
      this.completedOnboarding = false;
    }
  }

  private closeAllSheets(): void {
    this.activeSheets.forEach(sheet => sheet.dismiss());
    this.activeSheets.clear();
  }

  private setupSubscriptions(): void {
    // Tab changes
    this.uiStateService.currentTab$.pipe(takeUntil(this.destroy$)).subscribe(tab => {
      this.currentTab = tab;
    });

    // Single Rclone engine event listener (consolidated)
    this.setupRcloneEngineListener();

    // OAuth event listener
    this.setupRcloneOAuthListener();
  }

  private setupRcloneEngineListener(): void {
    this.eventListenersService
      .listenToRcloneEngine()
      .pipe(
        takeUntil(this.destroy$),
        filter(event => typeof event === 'object' && event !== null)
      )
      .subscribe({
        next: async event => {
          try {
            await this.handleRcloneEngineEvent(event as RcloneEngineEvent);
          } catch (error) {
            console.error('Error in Rclone engine event handler:', error);
          }
        },
        error: error => console.error('Rclone engine event subscription error:', error),
      });
  }

  private setupRcloneOAuthListener(): void {
    this.eventListenersService
      .listenToRcloneOAuth()
      .pipe(
        takeUntil(this.destroy$),
        filter(event => typeof event === 'object' && event !== null)
      )
      .subscribe({
        next: async event => {
          try {
            await this.handleRcloneOAuthEvent(event as RcloneEngineEvent);
          } catch (error) {
            console.error('Error in OAuth event handler:', error);
          }
        },
        error: error => console.error('OAuth event subscription error:', error),
      });
  }

  private async checkOnboardingStatus(): Promise<void> {
    try {
      this.completedOnboarding =
        (await this.appSettingsService.loadSettingValue('core', 'completed_onboarding')) ?? false;

      console.log('Onboarding status: ', this.completedOnboarding);

      if (this.completedOnboarding) {
        await this.postOnboardingSetup();
      }
    } catch (error) {
      console.error('Error checking onboarding status:', error);
      this.completedOnboarding = false;
    }
  }

  private async postOnboardingSetup(): Promise<void> {
    await this.checkMountPluginStatus();
  }

  private async checkMountPluginStatus(): Promise<void> {
    try {
      const mountPluginOk = await this.installationService.isMountPluginInstalled();
      console.log('Mount plugin status: ', mountPluginOk);

      if (!mountPluginOk) {
        await this.showRepairSheet({
          type: RepairSheetType.MOUNT_PLUGIN,
          title: 'Mount Plugin Problem',
          message:
            'The mount plugin could not be found or started. You can reinstall or repair it now.',
        });

        this.setupMountPluginInstallationListener();
      }
    } catch (error) {
      console.error('Error checking mount plugin status:', error);
    }
  }

  private setupMountPluginInstallationListener(): void {
    this.eventListenersService
      .listenToMountPluginInstalled()
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.closeSheetsByType(RepairSheetType.MOUNT_PLUGIN);
      });
  }

  private async handleRcloneEngineEvent(event: RcloneEngineEvent): Promise<void> {
    console.log('Rclone Engine event:', event);

    try {
      // Handle different event types
      switch (event.status) {
        case 'path_error':
          if (this.completedOnboarding) {
            this.handleRclonePathError();
          }
          break;

        case 'error':
          if (this.isPasswordErrorEvent(event)) {
            console.log('🔑 Password required detected from engine event');
            await this.handlePasswordRequired();
          }
          break;

        case 'ready':
          console.log('Rclone API ready');
          this.handleRcloneReady();
          break;

        default:
          // Log unknown events for debugging
          if (event.status) {
            console.log(`Unhandled Rclone event status: ${event.status}`);
          }
          break;
      }
    } catch (error) {
      console.error('Error handling Rclone Engine event:', error);
    }
  }

  private isPasswordErrorEvent(event: RcloneEngineEvent): boolean {
    // Rely on the backend's error classification
    return event.status === 'error' && event.error_type === 'password_required';
  }

  private async handleRcloneOAuthEvent(event: RcloneEngineEvent): Promise<void> {
    console.log('OAuth event received:', event);

    try {
      // Handle different OAuth event types
      switch (event.status) {
        case 'error':
          if (event.error_type === 'password_required') {
            console.log('🔑 OAuth password error detected:', event.message);
            await this.handlePasswordRequired();
          } else if (event.error_type === 'spawn_failed') {
            console.error('🚫 OAuth process failed to start:', event.message);
            // Could show a notification or repair sheet for OAuth spawn failures
          } else if (event.error_type === 'startup_timeout') {
            console.error('⏰ OAuth process startup timeout:', event.message);
            // Could show a notification or repair sheet for OAuth timeouts
          } else {
            console.warn('Unknown OAuth error:', event.message);
          }
          break;

        case 'success':
          console.log('✅ OAuth process started successfully:', event.message);
          break;

        default:
          // Log unknown OAuth events for debugging
          if (event.status) {
            console.log(`Unhandled OAuth event status: ${event.status}`);
          }
          break;
      }
    } catch (error) {
      console.error('Error handling OAuth event:', error);
    }
  }

  //#region Password Handling
  private async handlePasswordRequired(): Promise<void> {
    // Prevent multiple concurrent password prompts
    if (
      this.passwordPromptInProgress ||
      this.hasActiveSheetOfType(RepairSheetType.RCLONE_PASSWORD)
    ) {
      console.log('Password prompt already in progress, skipping...');
      return;
    }

    this.passwordPromptInProgress = true;

    try {
      const result = await this.promptForPassword();
      if (result?.password) {
        await this.rclonePasswordService.unlockConfig(result.password);
        console.log('Password set successfully');
      } else {
        console.log('Password prompt was cancelled or no password provided');
      }
    } catch (error) {
      console.error('Error handling password requirement:', error);
      throw error;
    } finally {
      this.passwordPromptInProgress = false;
    }
  }

  private async promptForPassword(): Promise<PasswordPromptResult | null> {
    const repairData: RepairData = {
      type: RepairSheetType.RCLONE_PASSWORD,
      title: 'Rclone Configuration Password Required',
      message: 'Your rclone configuration requires a password to access encrypted remotes.',
      requiresPassword: true,
      showStoreOption: true,
      passwordDescription:
        'Your rclone configuration requires a password to access encrypted remotes.',
    };

    return this.openRepairSheetWithResult(repairData);
  }
  //#endregion

  //#region Rclone Error Handling
  private handleRclonePathError(): void {
    if (this.alreadyReported) return;

    this.alreadyReported = true;
    this.showRepairSheet({
      type: RepairSheetType.RCLONE_PATH,
      title: 'Rclone Path Problem',
      message: 'The Rclone binary could not be found or started. You can reinstall it now.',
    });
  }

  private handleRcloneReady(): void {
    this.alreadyReported = false;
    this.passwordPromptInProgress = false; // Reset password prompt flag
    this.closeSheetsByTypes([RepairSheetType.RCLONE_PATH, RepairSheetType.RCLONE_PASSWORD]);
  }
  //#endregion

  //#region Sheet Management Utilities
  private async showRepairSheet(data: RepairData): Promise<void> {
    const sheetRef = this.bottomSheet.open(RepairSheetComponent, {
      data,
      disableClose: true,
    });

    this.activeSheets.add(sheetRef);

    sheetRef
      .afterDismissed()
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.activeSheets.delete(sheetRef);
      });
  }

  private async openRepairSheetWithResult(data: RepairData): Promise<PasswordPromptResult | null> {
    const sheetRef = this.bottomSheet.open(RepairSheetComponent, {
      data,
      disableClose: true,
    });

    this.activeSheets.add(sheetRef);

    try {
      const result = await firstValueFrom(sheetRef.afterDismissed());
      return (result as PasswordPromptResult) ?? null;
    } catch (error) {
      console.error('Error in repair sheet:', error);
      return null;
    } finally {
      this.activeSheets.delete(sheetRef);
      // Reset password prompt flag when sheet is dismissed
      if (data.type === RepairSheetType.RCLONE_PASSWORD) {
        this.passwordPromptInProgress = false;
      }
    }
  }

  private hasActiveSheetOfType(type: RepairSheetType): boolean {
    return Array.from(this.activeSheets).some(
      sheet => sheet.instance instanceof RepairSheetComponent && sheet.instance.data?.type === type
    );
  }

  private closeSheetsByType(type: RepairSheetType): void {
    Array.from(this.activeSheets).forEach(sheet => {
      if (sheet.instance instanceof RepairSheetComponent && sheet.instance.data?.type === type) {
        sheet.dismiss();
      }
    });
  }

  private closeSheetsByTypes(types: RepairSheetType[]): void {
    Array.from(this.activeSheets).forEach(sheet => {
      if (
        sheet.instance instanceof RepairSheetComponent &&
        types.includes(sheet.instance.data?.type as RepairSheetType)
      ) {
        sheet.dismiss();
      }
    });
  }

  //#endregion

  async finishOnboarding(): Promise<void> {
    try {
      this.completedOnboarding = true;
      await this.appSettingsService.saveSetting('core', 'completed_onboarding', true);
      console.log('Onboarding completed status saved.');

      await this.postOnboardingSetup();
    } catch (error) {
      console.error('Error saving onboarding status:', error);
      this.completedOnboarding = false;
      throw error;
    }
  }

  async setTab(tab: AppTab): Promise<void> {
    if (this.currentTab === tab) {
      return;
    }

    try {
      this.currentTab = tab;
      this.uiStateService.setTab(tab);
    } catch (error) {
      console.error('Error setting tab:', error);
    }
  }
}
