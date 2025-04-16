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
import { MatBottomSheet, MatBottomSheetModule } from "@angular/material/bottom-sheet";
// import { RightClickDirective } from './directives/right-click.directive';

@Component({
  selector: "app-root",
  imports: [
    CommonModule,
    RouterOutlet,
    TitlebarComponent,
    OnboardingComponent,
    HomeComponent /*, RightClickDirective*/,
    MatBottomSheetModule
  ],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.scss",
})
export class AppComponent {
  completedOnboarding: boolean = false;
  private emit_listened = false;
  private bottomSheet = inject(MatBottomSheet);

  constructor(
    private settingsService: SettingsService,
    private iconService: IconService,
  ) {
    this.checkOnboardingStatus();
 
  }

  private checkOnboardingStatus(): void {
    this.settingsService
      .loadSettings()
      .then((data) => {
        console.log("Settings loaded:", data);
        this.completedOnboarding =
          data.settings.core?.completed_onboarding ?? false;
        console.log("Onboarding status: ", this.completedOnboarding);
  
        if (this.completedOnboarding) {
          this.listenForErrors(); // ✅ move listener here
        }
      })
      .catch((error) => {
        console.error("Error loading settings:", error);
      });
  }
  
  private listenForErrors() {
    listen<string>("rclone_path_invalid", () => {
      this.bottomSheet.open(RepairSheetComponent, {
        data: {
          type: "rclone_path",
          title: "Rclone Path Problem",
          message:
            "The Rclone binary could not be found or started. You can reinstall it now.",
        },
        disableClose: true,
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
