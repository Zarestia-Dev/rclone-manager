import { Component, inject, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import { Subject, takeUntil } from 'rxjs';
import { TitlebarComponent } from './layout/titlebar/titlebar.component';
import { OnboardingComponent } from './features/onboarding/onboarding.component';
import { HomeComponent } from './home/home.component';
import {
  MatBottomSheet,
  MatBottomSheetModule,
  MatBottomSheetRef,
} from '@angular/material/bottom-sheet';
import { TabsButtonsComponent } from './layout/tabs-buttons/tabs-buttons.component';
import { UiStateService } from './services/ui/ui-state.service';
import { AppSettingsService } from './services/settings/app-settings.service';
import { SystemInfoService } from './services/system/system-info.service';
import { AppTab } from './shared/components/types';
import { InstallationService } from './services/settings/installation.service';
import { RepairSheetComponent } from './features/components/repair-sheet/repair-sheet.component';
import { ShortcutHandlerDirective } from './shared/directives/shortcut-handler.directive';

@Component({
  selector: 'app-root',
  imports: [
    CommonModule,
    RouterOutlet,
    TitlebarComponent,
    OnboardingComponent,
    MatBottomSheetModule,
    TabsButtonsComponent,
    HomeComponent,
    ShortcutHandlerDirective,
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
  private systemInfoService = inject(SystemInfoService);

  // Subscription management
  private destroy$ = new Subject<void>();
  private activeBottomSheets: MatBottomSheetRef<RepairSheetComponent>[] = [];

  constructor() {
    this.checkOnboardingStatus().catch(error => {
      console.error('Error during onboarding status check:', error);
    });
  }

  ngOnInit(): void {
    this.setupSubscriptions();
  }

  ngOnDestroy(): void {
    // Complete the destroy subject to trigger takeUntil in all subscriptions
    this.destroy$.next();
    this.destroy$.complete();

    // Close any open bottom sheets
    this.activeBottomSheets.forEach(sheet => {
      if (sheet) {
        sheet.dismiss();
      }
    });
    this.activeBottomSheets = [];
  }

  private setupSubscriptions(): void {
    // Subscribe to tab changes with proper cleanup
    this.uiStateService.currentTab$.pipe(takeUntil(this.destroy$)).subscribe(tab => {
      this.currentTab = tab;
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

    this.activeBottomSheets.push(sheetRef);

    // Setup event listener for mount plugin installation using InstallationService
    try {
      this.installationService
        .listenToMountPluginInstalled()
        .pipe(takeUntil(this.destroy$))
        .subscribe(() => {
          this.closeBottomSheet(sheetRef);
        });
    } catch (error) {
      console.error('Error setting up mount plugin event listener:', error);
    }
  }

  private setupErrorListeners(): void {
    // Listen for rclone path invalid errors with proper cleanup
    this.systemInfoService
      .listenToRclonePathInvalid()
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.handleRclonePathError();
      });
  }

  private handleRclonePathError(): void {
    if (this.alreadyReported) {
      return;
    }

    this.alreadyReported = true;
    const sheetRef = this.bottomSheet.open(RepairSheetComponent, {
      data: {
        type: 'rclone_path',
        title: 'Rclone Path Problem',
        message: 'The Rclone binary could not be found or started. You can reinstall it now.',
      },
      disableClose: true,
    });

    this.activeBottomSheets.push(sheetRef);

    // Listen for rclone API ready to dismiss the error sheet
    this.systemInfoService
      .listenToRcloneApiReady()
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.alreadyReported = false;
        this.closeBottomSheet(sheetRef);
      });
  }

  private closeBottomSheet(sheetRef: MatBottomSheetRef<RepairSheetComponent>): void {
    try {
      if (sheetRef) {
        sheetRef.dismiss();
        // Remove from active sheets array
        const index = this.activeBottomSheets.indexOf(sheetRef);
        if (index > -1) {
          this.activeBottomSheets.splice(index, 1);
        }
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
