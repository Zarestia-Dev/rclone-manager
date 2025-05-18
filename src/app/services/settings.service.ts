import { Injectable } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { InfoService } from "./info.service";
export interface CheckResult {
  successful: string[];
  failed: Record<string, string>;
  retries_used: Record<string, number>;
}

@Injectable({
  providedIn: "root",
})
export class SettingsService {
  isMobile$: any;
  constructor(private infoService: InfoService) {}

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

  async load_setting_value(category: string, key: string): Promise<any> {
    try {
      const setting = await invoke("load_setting_value", { category, key });
      console.log("Loaded setting key:", setting);
      return setting;
    } catch (error) {
      console.error("Failed to load setting key:", error);
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

  async backupSettings(
    selectedPath: string,
    selectedOption: string,
    password: string,
    remoteName: string
  ): Promise<void> {
    try {
      const result = await invoke("backup_settings", {
        backupDir: selectedPath,
        exportType: selectedOption,
        password: password,
        remoteName: remoteName,
      });
      this.infoService.openSnackBar(String(result), "OK");
    } catch (error) {
      this.infoService.openSnackBar(String(error), "OK");
      console.error("Failed to backup settings:", error);
    }
  }

  async restoreSettings(path: string): Promise<void> {
    try {
      const result = await invoke("restore_settings", { backupPath: path });
      this.infoService.openSnackBar(String(result), "OK");
    } catch (error) {
      this.infoService.openSnackBar(String(error), "OK");
      console.error("Failed to restore settings:", error);
    }
  }

  async analyzeBackupFile(path: string): Promise<any> {
    try {
      return await invoke("analyze_backup_file", { path });
    } catch (error) {
      this.infoService.alertModal("Error", String(error));
      console.error("Failed to analyze backup file:", error);
      return null;
    }
  }

  async restore_encrypted_settings(
    path: string,
    password: string
  ): Promise<void> {
    try {
      const result = await invoke("restore_encrypted_settings", {
        path,
        password,
      });
      this.infoService.openSnackBar(String(result), "OK");
    } catch (error) {
      this.infoService.openSnackBar(String(error), "OK");
      console.error("Failed to restore encrypted settings:", error);
    }
  }

  async check7zSupport(): Promise<boolean> {
    try {
      return await invoke("is_7z_available");
    } catch (error) {
      console.error("Failed to check 7z support:", error);
      return false;
    }
  }

  async resetSettings(): Promise<void> {
    try {
      const result = await this.infoService.confirmModal(
        "Reset Settings",
        "Are you sure you want to reset all settings? This action cannot be undone."
      );
      if (result) {
        await invoke("reset_settings");
        console.log("Settings reset successfully.");
      }
    } catch (error) {
      console.error("Failed to reset settings:", error);
    }
  }

  async resetRemoteSettings(remoteName: string): Promise<void> {
    try {
      await invoke("delete_remote_settings", { remoteName });
      console.log(`Settings for ${remoteName} deleted successfully.`);
    } catch (error) {
      console.error(`Failed to reset settings for ${remoteName}:`, error);
    }
  }

  async checkInternetLinks(
    links: string,
    maxRetries: number,
    retryDelaySecs: number
  ): Promise<CheckResult> {
    return await invoke<CheckResult>("check_links", {
      links,
      maxRetries,
      retryDelaySecs,
    });
  }
}
