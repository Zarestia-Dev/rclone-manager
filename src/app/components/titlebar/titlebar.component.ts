import { Component, OnInit, OnDestroy } from "@angular/core";
import { MatMenuModule } from "@angular/material/menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { MatDividerModule } from "@angular/material/divider";
import { CommonModule } from "@angular/common";
import { invoke } from "@tauri-apps/api/core";
import { MatDialog } from "@angular/material/dialog";
import { RemoteConfigModalComponent } from "../../modals/remote-config-modal/remote-config-modal.component";
import { PreferencesModalComponent } from "../../modals/preferences-modal/preferences-modal.component";
import { KeyboardShortcutsModalComponent } from "../../modals/keyboard-shortcuts-modal/keyboard-shortcuts-modal.component";
import { AboutModalComponent } from "../../modals/about-modal/about-modal.component";

const appWindow = getCurrentWindow();

@Component({
  selector: "app-titlebar",
  standalone: true,
  imports: [MatMenuModule, MatDividerModule, CommonModule],
  templateUrl: "./titlebar.component.html",
  styleUrl: "./titlebar.component.scss",
})
export class TitlebarComponent implements OnInit, OnDestroy {
  constructor(private dialog: MatDialog) {}

  closeWindow() {
    appWindow.close();
  }

  minimizeWindow() {
    appWindow.minimize();
  }

  maximizeWindow() {
    appWindow.toggleMaximize();
  }

  selectedTheme: string = "system";
  private darkModeMediaQuery: MediaQueryList | null = null;
  private mediaQueryListener: ((event: MediaQueryListEvent) => void) | null =
    null;

  async setTheme(theme: string) {
    this.selectedTheme = theme;
    localStorage.setItem("app-theme", theme);

    // Apply the theme to the app
    if (theme === "system") {
      const systemTheme = this.getSystemTheme();
      document.documentElement.setAttribute("class", systemTheme);
      await invoke("set_theme", { theme: systemTheme });
    } else {
      document.documentElement.setAttribute("class", theme);
      await invoke("set_theme", { theme });
    }
  }

  openRemoteConfigModal(
    remoteType?: string,
    remoteConfig?: any,
    mountConfig?: any
  ): void {
    const dialogRef = this.dialog.open(RemoteConfigModalComponent, {
      width: "70vw",
      maxWidth: "800px",
      height: "80vh",
      maxHeight: "600px",
      disableClose: true,
      data: {
        mode: remoteConfig ? "edit" : "add", // Determine if it's 'add' or 'edit' mode
        remoteType: remoteType, // Pass the remote type (e.g., 'Google Drive', 'AWS S3')
        remote: remoteConfig, // Pass existing remote config for editing
        mount: mountConfig, // Pass existing mount config for editing
      },
    });

    dialogRef.afterClosed().subscribe((result) => {
      if (result) {
        console.log("Remote Config Saved:", result);
        // Handle the saved data here
        // result will contain { remote: {...}, mount: {...} }
      }
    });
  }

  openPreferencesModal() {
    const dialogRef = this.dialog.open(PreferencesModalComponent, {
      width: "70vw",
      maxWidth: "800px",
      height: "80vh",
      maxHeight: "600px",
      disableClose: true,
    });

    dialogRef.afterClosed().subscribe((result) => {
      console.log("Modal closed:", result);
    });
  }

  openKeyboardShortcutsModal() {
    this.dialog.open(KeyboardShortcutsModalComponent, {
      width: "450px",
      disableClose: true,
    });
  }

  openAboutModal() {
    this.dialog.open(AboutModalComponent, {
      width: "400px",
      disableClose: true,
    });
  }

  ngOnInit() {
    this.selectedTheme = localStorage.getItem("app-theme") || "system";
    this.setTheme(this.selectedTheme);

    // Listen for system theme changes
    this.darkModeMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    this.mediaQueryListener = (event) => {
      if (this.selectedTheme === "system") {
        const systemTheme = event.matches ? "dark" : "light";
        document.documentElement.setAttribute("class", systemTheme);
        invoke("set_theme", { theme: systemTheme });
      }
    };
    this.darkModeMediaQuery.addEventListener("change", this.mediaQueryListener);
  }

  ngOnDestroy() {
    // Clean up the event listener
    if (this.darkModeMediaQuery && this.mediaQueryListener) {
      this.darkModeMediaQuery.removeEventListener(
        "change",
        this.mediaQueryListener
      );
    }
  }

  public getSystemTheme(): "light" | "dark" {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
}
