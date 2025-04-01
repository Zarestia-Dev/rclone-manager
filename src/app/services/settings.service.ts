import { Injectable } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";

@Injectable({
  providedIn: "root",
})

export class SettingsService {
  
  constructor() {}
  
  async loadSettings(): Promise<any> {
    try {
      const settings = await invoke("load_settings");
      console.log("Loaded settings:", settings);
      return settings;
    }
    catch (error) {
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
      console.log("Failed to save setting:", error)
    }
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
