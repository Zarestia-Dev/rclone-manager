import { Injectable } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";

export interface AppSettings {
  tray_enabled: boolean;
  start_minimized: boolean;
  auto_refresh: boolean;
  notifications: boolean;
  rclone_api_port: number;
  default_mount_type: string;
  debug_logging: boolean;
  bandwidth_limit: string;
}

@Injectable({
  providedIn: "root",
})

export class SettingsService {
  private settings: AppSettings | null = null;
  
  constructor() {}
  
  async loadSettings(): Promise<AppSettings> {
    if (this.settings) return this.settings;
    this.settings = await invoke<AppSettings>("load_settings");
    return this.settings;
  }

  async saveSettings(settings: AppSettings) {
    this.settings = settings;
    console.log("Saved settings", settings);
    await invoke("save_settings", { settings });
  }

  async saveRemoteSettings(remoteName: string, settings: any) {
    try {
      await invoke("save_remote_settings", { remoteName, settings });
    }
    catch (error) {
      console.error("Failed to save remote settings:", error);
    }
  }

  async getRemoteSettings(remoteName: string): Promise<any> {
    try {
      const settings = await invoke("get_remote_settings", { remoteName });
      console.log(`Loaded settings for ${remoteName}:`, settings);
      return settings;
    } catch (error) {
      console.error(`Failed to load settings for ${remoteName}:`, error);
      return null; // Return null if not found
    }
  }
  
}
