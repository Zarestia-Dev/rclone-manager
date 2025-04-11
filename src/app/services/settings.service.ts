import { Injectable } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import {
  ConfirmDialogData,
  ConfirmModalComponent,
} from "../modals/confirm-modal/confirm-modal.component";
import { MatDialog } from "@angular/material/dialog";

@Injectable({
  providedIn: "root",
})
export class SettingsService {
  constructor(private dialog: MatDialog) {}

  confirmModal(title: string, message: string) {
    // Create the confirmation dialog data
    const dialogData: ConfirmDialogData = {
      title: title,
      message: message,
      cancelText: "No",
      confirmText: "Yes",
    };

    return new Promise((resolve) => {
      const dialogRef = this.dialog.open(ConfirmModalComponent, {
        width: "300px",
        data: dialogData,
      });
      dialogRef.afterClosed().subscribe((result) => {
        resolve(result);
      });
    });
  }

  async loadSettings(): Promise<any> {
    try {
      const settings = await invoke("load_settings");
      console.log("Loaded settings:", settings);
      return settings;
    } catch (error) {
      console.error("Failed to load settings:", error);
      return null;
    }
  }

  /** ✅ Save only updated settings */
  async saveSetting(category: string, key: string, value: any): Promise<void> {
    try {
      const updatedSetting = { [category]: { [key]: value } }; // ✅ Send only the updated key
      console.log("Saving setting:", updatedSetting);
      await invoke("save_settings", { updatedSettings: updatedSetting });
    } catch (error) {
      console.log("Failed to save setting:", error);
    }
  }

  async saveRemoteSettings(remoteName: string, settings: any) {
    try {
      await invoke("save_remote_settings", { remoteName, settings });
    } catch (error) {
      console.error("Failed to save remote settings:", error);
    }
  }

  async getRemoteSettings(): Promise<any> {
    try {
      const settings = await invoke("get_settings");
      console.log("Fetched remote settings:", settings);
      return settings;
    } catch (error) {
      console.error("Failed to fetch remote settings:", error);
      return null; // Return null if not found
    }
  }

  async backupSettings(path: string): Promise<void> {
    try {
      await invoke("backup_settings", { backupDir: path });
      console.log("Settings backed up successfully.");
    } catch (error) {
      console.error("Failed to backup settings:", error);
    }
  }

  async restoreSettings(path: string): Promise<void> {
    try {
      await invoke("restore_settings", { backupPath: path });
      console.log("Settings restored successfully.");
    } catch (error) {
      console.error("Failed to restore settings:", error);
    }
  }

  async resetSettings(): Promise<void> {
    try {
      this.confirmModal(
        "Reset Settings",
        "Are you sure you want to reset all settings to default?"
      ).then(async (result) => {
        if (result) {
          await invoke("reset_settings");
          console.log("Settings reset successfully.");
        }
      });
    } catch (error) {
      console.error("Failed to reset settings:", error);
    }
  }

  async resetRemoteSettings(remoteName: string): Promise<void> {
    try {
      this.confirmModal(
        "Reset Remote Settings",
        `Are you sure you want to reset settings for ${remoteName}?`
      ).then(async (result) => {
        if (result) {
          await invoke("delete_remote_settings", { remoteName });
          console.log(`Settings for ${remoteName} deleted successfully.`);
        }
      });
    } catch (error) {
      console.error(`Failed to reset settings for ${remoteName}:`, error);
    }
  }
}
