import {
  Component,
  OnInit,
  OnDestroy,
  HostListener,
} from "@angular/core";
import { MatDialog } from "@angular/material/dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { Subject, BehaviorSubject, Subscription } from "rxjs";
import { takeUntil, take } from "rxjs/operators";
import { InputModalComponent } from "../../shared/modals/input-modal/input-modal.component";

// Services
import { MatDividerModule } from "@angular/material/divider";
import { MatIconModule } from "@angular/material/icon";
import { CommonModule } from "@angular/common";
import { MatMenuModule } from "@angular/material/menu";
import { MatButtonModule } from "@angular/material/button";
import { MatTooltipModule } from "@angular/material/tooltip";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { CheckResult } from "../../shared/components/types";
import { BackupRestoreService } from "../../services/settings/backup-restore.service";
import { FileSystemService } from "../../services/file-operations/file-system.service";
import { AppSettingsService } from "../../services/settings/app-settings.service";
import { UiStateService } from "../../services/ui/ui-state.service";
import { ExportModalComponent } from "../../features/modals/file-operations/export-modal/export-modal.component";
import { PreferencesModalComponent } from "../../features/modals/settings/preferences-modal/preferences-modal.component";
import { KeyboardShortcutsModalComponent } from "../../features/modals/settings/keyboard-shortcuts-modal/keyboard-shortcuts-modal.component";
import { AboutModalComponent } from "../../features/modals/settings/about-modal/about-modal.component";
import { QuickAddRemoteComponent } from "../../features/modals/remote-management/quick-add-remote/quick-add-remote.component";
import { RemoteConfigModalComponent } from "../../features/modals/remote-management/remote-config-modal/remote-config-modal.component";

type Theme = "light" | "dark" | "system";
type ModalSize = {
  width: string;
  maxWidth: string;
  minWidth: string;
  height: string;
  maxHeight: string;
};

type ConnectionStatus = "online" | "offline" | "checking";

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
  standalone: true,
  imports: [
    MatMenuModule,
    MatDividerModule,
    CommonModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: "./titlebar.component.html",
  styleUrls: ["./titlebar.component.scss"],
})
export class TitlebarComponent implements OnInit, OnDestroy {
  selectedTheme: Theme = "light";
  isMacOS: boolean = false;
  connectionStatus: ConnectionStatus = "online";
  connectionHistory: { timestamp: Date; result: CheckResult }[] = [];
  result?: CheckResult;

  private darkModeMediaQuery: MediaQueryList | null = null;
  private destroy$ = new Subject<void>();
  private internetCheckSub?: Subscription;
  private systemTheme$ = new BehaviorSubject<"light" | "dark">(
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  );

  constructor(
    private dialog: MatDialog,
    private backupRestoreService: BackupRestoreService,
    private fileSystemService: FileSystemService,
    private appSettingsService: AppSettingsService,
    private uiStateService: UiStateService
  ) {
    if (this.uiStateService.platform === "macos") {
      this.isMacOS = true;
    }
  }

  async ngOnInit(): Promise<void> {
    try {
      const theme = await this.appSettingsService.loadSettingValue(
        "general",
        "theme"
      );
      if (theme && theme !== this.selectedTheme) {
        this.selectedTheme = theme;
        await this.setTheme(this.selectedTheme, true);
      } else {
        this.applyTheme(this.systemTheme$.value);
      }

      this.initThemeSystem();
      await this.runInternetCheck();
    } catch (error) {
      console.error("Initialization error:", error);
      this.selectedTheme = "system";
      this.applyTheme(this.systemTheme$.value);
    }
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  // Theme Methods
  private initThemeSystem(): void {
    this.darkModeMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = (event: MediaQueryListEvent) => {
      this.systemTheme$.next(event.matches ? "dark" : "light");
      if (this.selectedTheme === "system") {
        this.applyTheme(this.systemTheme$.value);
      }
    };
    this.darkModeMediaQuery.addEventListener("change", listener);

    this.destroy$.pipe(take(1)).subscribe(() => {
      if (this.darkModeMediaQuery) {
        this.darkModeMediaQuery.removeEventListener("change", listener);
      }
    });
  }

  async setTheme(
    theme: Theme,
    isInitialization = false,
    event?: MouseEvent
  ): Promise<void> {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (this.selectedTheme === theme && !isInitialization) return;

    this.selectedTheme = theme;
    const effectiveTheme = theme === "system" ? this.systemTheme$.value : theme;
    this.applyTheme(effectiveTheme);

    if (!isInitialization) {
      try {
        await this.appSettingsService.saveSetting("general", "theme", theme);
      } catch (error) {
        console.error("Failed to save theme preference");
      }
    }
  }

  private applyTheme(theme: "light" | "dark"): void {
    document.documentElement.setAttribute("class", theme);
    invoke("set_theme", { theme }).catch(console.error);
  }

  // Connection Checking
  async runInternetCheck(): Promise<void> {
    if (this.connectionStatus === "checking") return;

    this.connectionStatus = "checking";
    try {
      const links = await this.appSettingsService.loadSettingValue(
        "core",
        "connection_check_urls"
      );

      console.log("Loaded connection check URLs:", links);

      if (this.internetCheckSub) {
        this.internetCheckSub.unsubscribe();
      }

      try {
        const result = await this.appSettingsService.checkInternetLinks(
          links,
          2, // retries
          3 // delay in seconds
        );
        console.log("Connection check result:", result);

        this.result = result;
        this.connectionHistory.unshift({
          timestamp: new Date(),
          result: result,
        });
        if (this.connectionHistory.length > 5) {
          this.connectionHistory.pop();
        }
        this.connectionStatus =
          Object.keys(this.result?.failed || {}).length > 0
            ? "offline"
            : "online";
      } catch (err) {
        console.error("Connection check failed:", err);
        this.result = { successful: [], failed: {}, retries_used: {} };
        this.connectionStatus = "offline";
        console.error("Connection check failed");
      }
    } catch (err) {
      console.error("Connection check error:", err);
      this.connectionStatus = "offline";
      console.error("Failed to load connection check settings");
    }
  }

  getInternetStatusTooltip(): string {
    if (this.connectionStatus === "checking")
      return "Checking internet connection...";

    if (this.result && Object.keys(this.result.failed).length > 0) {
      const services = Object.keys(this.result.failed)
        .map((url) => {
          if (url.includes("google")) return "Google Drive";
          if (url.includes("dropbox")) return "Dropbox";
          if (url.includes("onedrive")) return "OneDrive";
          return new URL(url).hostname;
        })
        .join(", ");

      return `Cannot connect to: ${services}. Some features may not work as expected. Click to retry.`;
    }

    return "Your internet connection is working properly.";
  }

  // Window Controls
  async minimizeWindow(): Promise<void> {
    try {
      await appWindow.minimize();
    } catch (error) {
      console.error("Failed to minimize window");
    }
  }

  async maximizeWindow(): Promise<void> {
    try {
      await appWindow.toggleMaximize();
    } catch (error) {
      console.error("Failed to toggle maximize");
    }
  }

  async closeWindow(): Promise<void> {
    try {
      await appWindow.close();
    } catch (error) {
      console.error("Failed to close window");
    }
  }

  // Modal Methods
  openQuickAddRemoteModal(): void {
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

  private openModal(component: any, size: ModalSize): void {
    this.dialog.open(component, {
      ...size,
      disableClose: true,
    });
  }

  // Other Methods
  resetRemote(): void {
    this.uiStateService.resetSelectedRemote();
  }

  async restoreSettings(): Promise<void> {
    const path = await this.fileSystemService.selectFile();
    if (!path) return;

    const result = await this.backupRestoreService.analyzeBackupFile(path);
    if (!result) return;

    if (result.isEncrypted) {
      this.handleEncryptedBackup(path);
    } else {
      await this.backupRestoreService.restoreSettings(path);
    }
  }

  private handleEncryptedBackup(path: string): void {
    const dialogRef = this.dialog.open(InputModalComponent, {
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
    });

    dialogRef
      .afterClosed()
      .pipe(takeUntil(this.destroy$))
      .subscribe(async (inputData) => {
        if (inputData?.password) {
          await this.backupRestoreService.restoreEncryptedSettings(
            path,
            inputData.password
          );
        }
      });
  }

  private cleanup(): void {
    this.destroy$.next();
    this.destroy$.complete();
    if (this.internetCheckSub) {
      this.internetCheckSub.unsubscribe();
    }
  }
}
