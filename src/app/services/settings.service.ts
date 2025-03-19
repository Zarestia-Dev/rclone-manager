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
}
