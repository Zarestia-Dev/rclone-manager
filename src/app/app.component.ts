import { Component, inject, OnInit, OnDestroy } from '@angular/core';
import { Subject, takeUntil, firstValueFrom } from 'rxjs';
import { TitlebarComponent } from './layout/titlebar/titlebar.component';
import { OnboardingComponent } from './features/onboarding/onboarding.component';
import { HomeComponent } from './home/home.component';
import {
  MatBottomSheet,
  MatBottomSheetModule,
  MatBottomSheetRef,
} from '@angular/material/bottom-sheet';
import { TabsButtonsComponent } from './layout/tabs-buttons/tabs-buttons.component';
import { AppTab, RepairData } from './shared/components/types';
import { RepairSheetComponent } from './features/components/repair-sheet/repair-sheet.component';
import { ShortcutHandlerDirective } from './shared/directives/shortcut-handler.directive';
import { BannerComponent } from './layout/banners/banner.component';

// Services
import { UiStateService } from '@app/services';
import { AppSettingsService } from '@app/services';
import { InstallationService } from '@app/services';
import { EventListenersService } from '@app/services';
import { RclonePasswordService } from '@app/services';

export interface PasswordPromptResult {
  password: string;
  stored: boolean;
}

interface RcloneEngineEvent {
  status?: string;
  message?: string;
  error_type?: string;
}

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
  completedOnboarding = true;
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

  constructor() {
    this.checkOnboardingStatus().catch(error => {
      console.error('Error during onboarding status check:', error);
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

  private closeAllSheets(): void {
    this.activeSheets.forEach(sheet => sheet.dismiss());
    this.activeSheets.clear();
  }

  private setupSubscriptions(): void {
    // Tab changes
    this.uiStateService.currentTab$.pipe(takeUntil(this.destroy$)).subscribe(tab => {
      this.currentTab = tab;
    });

    // Rclone engine events
    this.eventListenersService
      .listenToRcloneEngine()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: event => this.handleRcloneEngineEvent(event),
        error: error => console.error('Rclone engine event error:', error),
      });
  }

  private async checkOnboardingStatus(): Promise<void> {
    try {
      this.completedOnboarding =
        (await this.appSettingsService.loadSettingValue('core', 'completed_onboarding')) ?? false;
      console.log('Onboarding status: ', this.completedOnboarding);

      if (this.completedOnboarding) {
        await this.checkMountPluginStatus();
        this.setupErrorListeners();
        // Initialize password management
        // Some older versions exposed an initializer; call it if present.
        // Some older versions exposed an initializer; call it if present.
        const maybeInit = this.rclonePasswordService as unknown as {
          initializePassword?: () => Promise<void>;
        };
        if (maybeInit.initializePassword) {
          try {
            await maybeInit.initializePassword();
          } catch (e) {
            console.debug('initializePassword() failed or is not available:', e);
          }
        }
      }
    } catch (error) {
      console.error('Error checking onboarding status:', error);
      // Default to showing onboarding if we can't determine the status
      this.completedOnboarding = false;
    }
  }

  private async checkMountPluginStatus(): Promise<void> {
    try {
      const mountPluginOk = await this.installationService.isMountPluginInstalled();
      console.log('Mount plugin status: ', mountPluginOk);

      if (!mountPluginOk) {
        await this.showMountPluginRepairSheet();
      }
    } catch (error) {
      console.error('Error checking mount plugin status:', error);
    }
  }

  private async showMountPluginRepairSheet(): Promise<void> {
    const sheetRef = this.bottomSheet.open(RepairSheetComponent, {
      data: {
        type: 'mount_plugin',
        title: 'Mount Plugin Problem',
        message:
          'The mount plugin could not be found or started. You can reinstall or repair it now.',
      },
      disableClose: true,
    });

    this.activeSheets.add(sheetRef);

    // Setup event listener for mount plugin installation using EventListenersService
    try {
      this.eventListenersService
        .listenToMountPluginInstalled()
        .pipe(takeUntil(this.destroy$))
        .subscribe(() => {
          this.closeBottomSheet(sheetRef);
        });
    } catch (error) {
      console.error('Error setting up mount plugin event listener:', error);
    }
  }

  private handleRcloneEngineEvent(event: unknown): void {
    try {
      if (typeof event !== 'object' || event === null) return;

      const payload = event as RcloneEngineEvent;
      console.log('Rclone Engine event:', payload);

      // Handle path errors
      if (payload.status === 'path_error') {
        this.handleRclonePathError();
      }

      // Handle password errors
      if (this.isPasswordErrorEvent(payload)) {
        console.log('🔑 Password required detected from engine event');
        this.handlePasswordRequired().catch(error => {
          console.error('Failed to handle password requirement:', error);
        });
      }

      // Handle ready state
      if (payload.status === 'ready') {
        console.log('Rclone API ready');
        this.handleRcloneReady();
      }
    } catch (error) {
      console.error('Error handling Rclone event:', error);
    }
  }

  private isPasswordErrorEvent(payload: RcloneEngineEvent): boolean {
    return !!(
      payload.status === 'error' &&
      (payload.error_type === 'password_required' ||
        (payload.message && this.isPasswordError(payload.message)))
    );
  }

  private isPasswordError(error: string): boolean {
    const passwordErrorPatterns = [
      'Enter configuration password',
      'Failed to read line: EOF',
      'configuration is encrypted',
      'password required',
      'most likely wrong password.',
    ];

    return passwordErrorPatterns.some(pattern =>
      error.toLowerCase().includes(pattern.toLowerCase())
    );
  }

  //#region Password Handling
  private async handlePasswordRequired(): Promise<void> {
    // Check if we already have an active password sheet
    const existingSheet = Array.from(this.activeSheets).find(
      sheet =>
        sheet.instance instanceof RepairSheetComponent &&
        sheet.instance.data?.type === 'rclone_password'
    );

    if (existingSheet) return;

    try {
      const result = await this.promptForPassword();
      if (result?.password) {
        await this.rclonePasswordService.setConfigPasswordEnv(result.password);
      }
    } catch (error) {
      console.error('Error handling password requirement:', error);
      throw error;
    }
  }

  async promptForPassword(): Promise<PasswordPromptResult | null> {
    const repairData: RepairData = {
      type: 'rclone_password',
      title: 'Rclone Configuration Password Required',
      message: 'Your rclone configuration requires a password to access encrypted remotes.',
      requiresPassword: true,
      showStoreOption: true,
      passwordDescription:
        'Your rclone configuration requires a password to access encrypted remotes.',
    };

    const sheetRef = this.bottomSheet.open(RepairSheetComponent, {
      data: repairData,
      disableClose: true,
    });

    this.activeSheets.add(sheetRef);

    try {
      const result = await firstValueFrom(sheetRef.afterDismissed());
      return (result as PasswordPromptResult) ?? null;
    } catch (error) {
      console.error('Error in password prompt:', error);
      return null;
    } finally {
      this.activeSheets.delete(sheetRef);
    }
  }
  //#endregion

  //#region Rclone Error Handling
  private handleRclonePathError(): void {
    if (this.alreadyReported) return;

    this.alreadyReported = true;
    const sheetRef = this.bottomSheet.open(RepairSheetComponent, {
      data: {
        type: 'rclone_path',
        title: 'Rclone Path Problem',
        message: 'The Rclone binary could not be found or started. You can reinstall it now.',
      },
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

  private handleRcloneReady(): void {
    this.alreadyReported = false;

    // Close any error sheets when Rclone is ready
    Array.from(this.activeSheets).forEach(sheet => {
      if (
        sheet.instance instanceof RepairSheetComponent &&
        ['rclone_path', 'rclone_password'].includes(sheet.instance.data?.type)
      ) {
        sheet.dismiss();
      }
    });
  }
  //#endregion

  private setupErrorListeners(): void {
    // Listen for rclone engine errors with proper cleanup
    this.eventListenersService
      .listenToRcloneEngine()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: async event => {
          try {
            console.log('Rclone Engine event payload:', event);

            if (typeof event === 'object' && event?.status === 'path_error') {
              this.handleRclonePathError();
            }

            if (typeof event === 'object' && event.status !== null) {
              const payload = event as {
                status?: string;
                message?: string;
                error_type?: string;
              };
              console.log('🔑 Rclone engine event:', payload);

              // Check for password errors - both old and new format
              if (
                payload.status === 'error' &&
                (payload.error_type === 'password_required' || // New structured format
                  (payload.message && this.isPasswordError(payload.message))) // Legacy format
              ) {
                console.log('🔑 Password required detected from engine event');
                this.handlePasswordRequired();
              }
            }
          } catch (error) {
            console.error('Error handling Rclone Engine event:', error);
          }
        },
      });
  }

  private closeBottomSheet(sheetRef: MatBottomSheetRef<RepairSheetComponent>): void {
    try {
      if (sheetRef) {
        sheetRef.dismiss();
        // Remove from active sheets set
        this.activeSheets.delete(sheetRef);
      }
    } catch (error) {
      console.error('Error closing bottom sheet:', error);
    }
  }

  async finishOnboarding(): Promise<void> {
    try {
      this.completedOnboarding = true;

      // Save the onboarding status
      await this.appSettingsService.saveSetting('core', 'completed_onboarding', true);
      console.log('Onboarding completed status saved.');

      // Setup error listeners and check mount plugin after onboarding is complete
      this.setupErrorListeners();
      await this.checkMountPluginStatus();
    } catch (error) {
      console.error('Error saving onboarding status:', error);
      // Revert the onboarding status if saving failed
      this.completedOnboarding = false;
      throw error; // Re-throw to let the caller handle the error
    }
  }

  async setTab(tab: AppTab): Promise<void> {
    try {
      if (this.currentTab === tab) {
        return; // No need to change if already on the same tab
      }

      this.currentTab = tab;
      this.uiStateService.setTab(tab);
    } catch (error) {
      console.error('Error setting tab:', error);
    }
  }
}
