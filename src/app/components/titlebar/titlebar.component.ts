import { Component, OnInit, OnDestroy, HostListener } from "@angular/core";
import { MatDialog } from "@angular/material/dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { Observable } from "rxjs";
import { takeUntil } from "rxjs/operators";
import { Subject } from "rxjs";

// Components
import { RemoteConfigModalComponent } from "../../modals/remote-config-modal/remote-config-modal.component";
import { PreferencesModalComponent } from "../../modals/preferences-modal/preferences-modal.component";
import { KeyboardShortcutsModalComponent } from "../../modals/keyboard-shortcuts-modal/keyboard-shortcuts-modal.component";
import { AboutModalComponent } from "../../modals/about-modal/about-modal.component";
import { QuickAddRemoteComponent } from "../../modals/quick-add-remote/quick-add-remote.component";
import { ExportModalComponent } from "../../modals/export-modal/export-modal.component";
import { InputModalComponent } from "../../modals/input-modal/input-modal.component";

// Services
import { StateService } from "../../services/state.service";
import { SettingsService } from "../../services/settings.service";
import { RcloneService } from "../../services/rclone.service";
import { MatDividerModule } from "@angular/material/divider";
import { MatIconModule } from "@angular/material/icon";
import { CommonModule } from "@angular/common";
import { MatMenuModule } from "@angular/material/menu";
import { TabsButtonsComponent } from "../tabs-buttons/tabs-buttons.component";
import { MatButtonModule } from "@angular/material/button";

// Models
type Theme = "light" | "dark" | "system";
type ModalSize = {
  width: string;
  maxWidth: string;
  minWidth: string;
  height: string;
  maxHeight: string;
};

const appWindow = getCurrentWindow();
const STANDARD_MODAL_SIZE: ModalSize = {
  width: "90vw",
  maxWidth: "642px",
  minWidth: "360px",
  height: "80vh",
  maxHeight: "600px",
};

@Component({
  selector: "app-titlebar",
  imports: [
    MatMenuModule,
    MatDividerModule,
    CommonModule,
    MatIconModule,
    TabsButtonsComponent,
    MatButtonModule
  ],
  templateUrl: "./titlebar.component.html",
  styleUrls: ["./titlebar.component.scss"],
})
export class TitlebarComponent implements OnInit, OnDestroy {
  selectedTheme: Theme = "system";
  isMobile$: Observable<boolean>;

  private darkModeMediaQuery: MediaQueryList | null = null;
  private destroy$ = new Subject<void>();

  constructor(
    private dialog: MatDialog,
    private stateService: StateService,
    private rcloneService: RcloneService,
    private settingsService: SettingsService
  ) {
    this.isMobile$ = this.stateService.isMobile$;
  }

  async ngOnInit(): Promise<void> { // Change return type to Promise<void>
    try {
      const theme = await this.settingsService.load_setting_value("general", "theme");
      this.selectedTheme = theme || "system";
      this.setTheme(this.selectedTheme);
    } catch (error) {
      this.selectedTheme = "system";
      this.setTheme(this.selectedTheme);
    }

    this.initThemeSystem();
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  resetRemote(): void {
    this.stateService.resetSelectedRemote();
  }

  @HostListener("window:keydown", ["$event"])
  handleKeyboardShortcuts(event: KeyboardEvent): void {
    if (!event.ctrlKey) return;

    const keyHandlers: Record<string, () => void> = {
      ",": () => this.openPreferencesModal(),
      r: () => this.openQuickAddRemoteModal(),
      n: () => this.openRemoteConfigModal(),
      "?": () => this.openKeyboardShortcutsModal(),
      q: () => this.closeWindow(),
      w: () => this.closeWindow(),
    };

    if (keyHandlers[event.key]) {
      event.preventDefault();
      keyHandlers[event.key]();
    }
  }

  // Window controls
  closeWindow(): void {
    appWindow.close();
  }

  minimizeWindow(): void {
    appWindow.minimize();
  }

  maximizeWindow(): void {
    appWindow.toggleMaximize();
  }

  // Theme management
  async setTheme(theme: Theme): Promise<void> {
    this.selectedTheme = theme;
    const effectiveTheme = theme === "system" ? this.getSystemTheme() : theme;

    document.documentElement.setAttribute("class", effectiveTheme);
    await invoke("set_theme", { theme: effectiveTheme });
  }

  getSystemTheme(): "light" | "dark" {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  // Modal methods
  public openQuickAddRemoteModal(): void {
    this.openModal(QuickAddRemoteComponent, STANDARD_MODAL_SIZE);
  }

  openRemoteConfigModal(): void {
    this.openModal(RemoteConfigModalComponent, STANDARD_MODAL_SIZE);
  }

  openPreferencesModal(): void {
    this.openModal(PreferencesModalComponent, STANDARD_MODAL_SIZE);
  }

  openKeyboardShortcutsModal(): void {
    this.openModal(KeyboardShortcutsModalComponent, STANDARD_MODAL_SIZE);
  }

  openExportModal(): void {
    this.openModal(ExportModalComponent, STANDARD_MODAL_SIZE);
  }

  openAboutModal(): void {
    this.openModal(AboutModalComponent, {
      width: "362px",
      maxWidth: "362px",
      minWidth: "360px",
      height: "80vh",
      maxHeight: "600px",
    });
  }

  async restoreSettings(): Promise<void> {
    const path = await this.rcloneService.selectFile();
    if (!path) return;

    const result = await this.settingsService.analyzeBackupFile(path);
    if (!result) return;

    if (result.isEncrypted) {
      this.handleEncryptedBackup(path);
    } else {
      await this.settingsService.restoreSettings(path);
    }
  }

  // Private methods
  private initThemeSystem(): void {
    this.darkModeMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = (event: MediaQueryListEvent) => {
      if (this.selectedTheme === "system") {
        this.setTheme("system");
      }
    };
    this.darkModeMediaQuery.addEventListener("change", listener);
  }

  private openModal(component: any, size: ModalSize): void {
    const dialogRef = this.dialog.open(component, {
      ...size,
      disableClose: true,
    });

    dialogRef
      .afterClosed()
      .pipe(takeUntil(this.destroy$))
      .subscribe((result) => {
        console.log("Modal closed with:", result);
      });
  }

  private handleEncryptedBackup(path: string): void {
    this.dialog
      .open(InputModalComponent, {
        width: "400px",
        disableClose: true,
        data: {
          title: "Enter Password",
          description: "Please enter the password to decrypt the backup file.",
          fields: [
            {
              name: "password",
              label: "Password",
              type: "password",
              required: true,
            },
          ],
        },
      })
      .afterClosed()
      .pipe(takeUntil(this.destroy$))
      .subscribe(async (inputData) => {
        if (inputData?.password) {
          await this.settingsService.restore_encrypted_settings(
            path,
            inputData.password
          );
        }
      });
  }

  private cleanup(): void {
    this.destroy$.next();
    this.destroy$.complete();

    if (this.darkModeMediaQuery) {
      // Remove all listeners to be safe
      this.darkModeMediaQuery.removeEventListener("change", () => {});
    }
  }
}
