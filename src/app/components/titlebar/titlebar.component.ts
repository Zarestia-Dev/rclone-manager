import { Component, OnInit, OnDestroy } from "@angular/core";
import { MatIconModule } from "@angular/material/icon";
import { MatMenuModule } from "@angular/material/menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { MatDividerModule } from "@angular/material/divider";
import { CommonModule } from "@angular/common";
import { invoke } from "@tauri-apps/api/core";

const appWindow = getCurrentWindow();

@Component({
  selector: "app-titlebar",
  standalone: true,
  imports: [MatIconModule, MatMenuModule, MatDividerModule, CommonModule],
  templateUrl: "./titlebar.component.html",
  styleUrl: "./titlebar.component.scss",
})
export class TitlebarComponent implements OnInit, OnDestroy {

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
  private mediaQueryListener: ((event: MediaQueryListEvent) => void) | null = null;

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
      this.darkModeMediaQuery.removeEventListener("change", this.mediaQueryListener);
    }
  }

  public getSystemTheme(): "light" | "dark" {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
}