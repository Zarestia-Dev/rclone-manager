import { Component, inject, OnInit, OnDestroy, ChangeDetectorRef } from "@angular/core";
import { CommonModule } from "@angular/common";
import { RouterOutlet } from "@angular/router";
import { TitlebarComponent } from "./components/titlebar/titlebar.component";
import { OnboardingComponent } from "./components/onboarding/onboarding.component";
import { HomeComponent } from "./home/home.component";
import { SettingsService } from "./services/settings.service";
import { IconService } from "./services/icon.service";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { RepairSheetComponent } from "./components/repair-sheet/repair-sheet.component";
import {
  MatBottomSheet,
  MatBottomSheetModule,
} from "@angular/material/bottom-sheet";
import { TabsButtonsComponent } from "./components/tabs-buttons/tabs-buttons.component";
import { Observable } from "rxjs";
import { StateService } from "./services/state.service";
import { invoke } from "@tauri-apps/api/core";
import { MatToolbarModule } from "@angular/material/toolbar";
import {
  animate,
  state,
  style,
  transition,
  trigger,
} from "@angular/animations";
import { RcloneService } from "./services/rclone.service";

@Component({
  selector: "app-root",
  imports: [
    CommonModule,
    RouterOutlet,
    TitlebarComponent,
    OnboardingComponent,
    HomeComponent,
    MatBottomSheetModule,
    TabsButtonsComponent,
    MatToolbarModule,
  ],
  animations: [
    trigger("slideToggle", [
      state("hidden", style({ height: "0px", opacity: 0, overflow: "hidden" })),
      state("visible", style({ height: "*", opacity: 1, overflow: "hidden" })),
      transition("hidden <=> visible", animate("300ms ease-in-out")),
    ]),
  ],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.scss",
})
export class AppComponent implements OnInit, OnDestroy {
  completedOnboarding: boolean = true;
  alreadyReported: boolean = false;
  private bottomSheet = inject(MatBottomSheet);
  isMobile$: Observable<boolean>;
  isMeteredConnection: boolean = false;
  private unlistenNetworkStatus: UnlistenFn | null = null;

  constructor(
    private settingsService: SettingsService,
    private stateService: StateService,
    private cdr: ChangeDetectorRef,
    private rcloneService: RcloneService,
    private iconService: IconService
  ) {
    this.checkOnboardingStatus();
    this.isMobile$ = this.stateService.isMobile$;
  }

  ngOnInit() {
    this.checkMeteredConnection();
    this.listenForNetworkStatus();
  }

  ngOnDestroy() {
    if (this.unlistenNetworkStatus) {
      this.unlistenNetworkStatus();
      this.unlistenNetworkStatus = null;
    }
  }

  async checkMeteredConnection() {
    try {
      const isMetered = await invoke("is_network_metered");
      this.isMeteredConnection = !!isMetered;
      if (isMetered) {
        console.log("The network connection is metered.");
      } else {
        console.log("The network connection is not metered.");
      }
    } catch (e) {
      console.error("Failed to check metered connection:", e);
    }
  }

  private async listenForNetworkStatus() {
    this.unlistenNetworkStatus = await listen("network-status-changed", (event: any) => {
      const isMetered = event.payload?.isMetered;
      this.isMeteredConnection = !!isMetered;
      if (isMetered) {
        console.log("Network is metered. Showing banner.");
      } else {
        console.log("Network is not metered. Hiding banner.");
      }
      this.cdr.detectChanges();
    });
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
        const mountPluginOk = await invoke<boolean>(
          "check_mount_plugin_installed"
        );
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
    this.rcloneService.listenToRclonePathInvalid().subscribe(() => {
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
      this.rcloneService.listenToRcloneApiReady().subscribe(() => {
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
