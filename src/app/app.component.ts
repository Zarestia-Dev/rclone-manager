import { Component, inject, OnInit, OnDestroy } from "@angular/core";
import { CommonModule } from "@angular/common";
import { RouterOutlet } from "@angular/router";
import { TitlebarComponent } from "./layout/titlebar/titlebar.component";
import { OnboardingComponent } from "./features/onboarding/onboarding.component";
import { HomeComponent } from "./home/home.component";
import { listen } from "@tauri-apps/api/event";
import {
  MatBottomSheet,
  MatBottomSheetModule,
} from "@angular/material/bottom-sheet";
import { TabsButtonsComponent } from "./layout/tabs-buttons/tabs-buttons.component";
import { UiStateService } from "./services/ui/ui-state.service";
import { AppSettingsService } from "./services/settings/app-settings.service";
import { SystemInfoService } from "./services/system/system-info.service";
import { AppTab } from "./shared/components/types";
import { InstallationService } from "./services/settings/installation.service";
import { RepairSheetComponent } from "./features/components/repair-sheet/repair-sheet.component";

@Component({
  selector: "app-root",
  imports: [
    CommonModule,
    RouterOutlet,
    TitlebarComponent,
    OnboardingComponent,
    MatBottomSheetModule,
    TabsButtonsComponent,
    HomeComponent,
  ],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.scss",
})
export class AppComponent implements OnInit, OnDestroy {
  completedOnboarding: boolean = true;
  alreadyReported: boolean = false;
  currentTab: AppTab = "general";
  private bottomSheet = inject(MatBottomSheet);

  constructor(
    public uiStateService: UiStateService,
    public appSettingsService: AppSettingsService,
    private systemInfoService: SystemInfoService,
    private installationService: InstallationService
  ) {
    this.checkOnboardingStatus();
  }

  ngOnInit() {
    this.uiStateService.currentTab$.subscribe((tab) => {
      this.currentTab = tab;
    });
  }

  ngOnDestroy() {}

  private async checkOnboardingStatus(): Promise<void> {
    this.completedOnboarding =
      (await this.appSettingsService.loadSettingValue(
        "core",
        "completed_onboarding"
      )) ?? false;
    console.log("Onboarding status: ", this.completedOnboarding);

    if (this.completedOnboarding) {
      // Check mount plugin status
      try {
        const mountPluginOk =
          await this.installationService.isMountPluginInstalled();

        console.log("Mount plugin status: ", mountPluginOk);
        if (!mountPluginOk) {
          this.bottomSheet.open(RepairSheetComponent, {
            data: {
              type: "mount_plugin",
              title: "Mount Plugin Problem",
              message:
                "The mount plugin could not be found or started. You can reinstall or repair it now.",
            },
            disableClose: true,
          });
          listen("mount_plugin_installed", () => {
            this.bottomSheet.dismiss();
          });
        }
        this.listenForErrors();
      } catch (e) {
        console.error("Error checking mount plugin status:", e);
        this.listenForErrors();
      }
    }
  }

  private listenForErrors() {
    this.systemInfoService.listenToRclonePathInvalid().subscribe(() => {
      if (this.alreadyReported) {
        return;
      }
      this.alreadyReported = true;
      const sheetRef = this.bottomSheet.open(RepairSheetComponent, {
        data: {
          type: "rclone_path",
          title: "Rclone Path Problem",
          message:
            "The Rclone binary could not be found or started. You can reinstall it now.",
        },
        disableClose: true,
      });
      this.systemInfoService.listenToRcloneApiReady().subscribe(() => {
        this.alreadyReported = false;
        sheetRef.dismiss();
      });
    });
  }

  finishOnboarding() {
    this.completedOnboarding = true;
    // Save the onboarding status
    this.appSettingsService
      .saveSetting("core", "completed_onboarding", true)
      .then(() => {
        console.log("Onboarding completed status saved.");
      })
      .catch((error) => {
        console.error("Error saving onboarding status:", error);
      });
  }

  async setTab(tab: AppTab) {
    if (this.currentTab === tab) {
      return; // No need to change if already on the same tab
    }
    this.currentTab = tab;
    this.uiStateService.setTab(tab);
  }
}
