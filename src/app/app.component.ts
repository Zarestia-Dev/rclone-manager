import { Component, inject } from "@angular/core";
import { CommonModule } from "@angular/common";
import { RouterOutlet } from "@angular/router";
import { TitlebarComponent } from "./components/titlebar/titlebar.component";
import { OnboardingComponent } from "./components/onboarding/onboarding.component";
import { HomeComponent } from "./home/home.component";
import { SettingsService } from "./services/settings.service";
import { IconService } from "./services/icon.service";
import { listen } from "@tauri-apps/api/event";
import { RepairSheetComponent } from "./components/repair-sheet/repair-sheet.component";
import {
  MatBottomSheet,
  MatBottomSheetModule,
} from "@angular/material/bottom-sheet";
import { TabsButtonsComponent } from "./components/tabs-buttons/tabs-buttons.component";
import { Observable } from "rxjs";
import { StateService } from "./services/state.service";
import { invoke } from "@tauri-apps/api/core";
// import { RightClickDirective } from './directives/right-click.directive';

@Component({
  selector: "app-root",
  imports: [
    CommonModule,
    RouterOutlet,
    TitlebarComponent,
    OnboardingComponent,
    HomeComponent /*, RightClickDirective*/,
    MatBottomSheetModule,
    TabsButtonsComponent,
  ],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.scss",
})
export class AppComponent {
  completedOnboarding: boolean = true;
  alreadyReported: boolean = false;
  private bottomSheet = inject(MatBottomSheet);
  isMobile$: Observable<boolean>;

  constructor(
    private settingsService: SettingsService,
    private stateService: StateService,
    private iconService: IconService
  ) {
    this.checkOnboardingStatus();
    this.isMobile$ = this.stateService.isMobile$;
  }

  private async checkOnboardingStatus(): Promise<void> {
    this.completedOnboarding =
      (await this.settingsService.load_setting_value(
        "core",
        "completed_onboarding"
      )) ?? false;
    console.log("Onboarding status: ", this.completedOnboarding);

    if (this.completedOnboarding) {
      // Check mount plugin status
      try {
        const mountPluginOk = await invoke<boolean>("check_mount_plugin_installed");
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
    listen<string>("rclone_path_invalid", () => {
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
      listen("rclone_api_ready", () => {
        this.alreadyReported = false;
        sheetRef.dismiss();
      });
    });
  }

  finishOnboarding() {
    this.completedOnboarding = true;
    // Save the onboarding status
    this.settingsService
      .saveSetting("core", "completed_onboarding", true)
      .then(() => {
        console.log("Onboarding completed status saved.");
      })
      .catch((error) => {
        console.error("Error saving onboarding status:", error);
      });
  }

  // hideMenu() {
  //   const menu = document.getElementById('custom-menu');
  //   if (menu) {
  //     menu.style.display = 'none';
  //   }
  // }

  // onOptionClick(option: string) {
  //   alert(`You clicked: ${option}`);
  //   this.hideMenu();
  // }

  // // Hide menu when clicking anywhere outside
  // @HostListener('document:click')
  // onClickOutside() {
  //   this.hideMenu();
  // }
}
