import { Injectable } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";

@Injectable({
  providedIn: "root",
})
export class RcloneService {
  constructor() {}

  openInFiles(mountPoint: string): Promise<void> {
    try {
      return invoke("open_in_files", { path: mountPoint });
    } catch (err) {
      console.error("Failed to open file manager:", err);
      return Promise.reject(err);
    }
  }

  selectFolder(): Promise<string> {
    try {
      return invoke("get_folder_location");
    } catch (err) {
      console.error("Failed to open folder picker:", err);
      return Promise.reject(err);
    }
  }

  /** Get all available remote types */
  async getRemoteTypes(): Promise<{ name: string; description: string }[]> {
    try {
      const response = await invoke<{
        [key: string]: { Name: string; Description: string }[];
      }>("get_remote_types");

      // Convert PascalCase keys to camelCase
      const providers = Object.values(response)
        .flat()
        .map((provider) => ({
          name: provider.Name,
          description: provider.Description,
        }));

      console.log("Fetched remote types:", providers);
      return providers;
    } catch (error) {
      console.error("Failed to fetch remote types:", error);
      return [];
    }
  }

  /** ✅ Get only OAuth-supported remote types */
  async getOAuthSupportedRemotes(): Promise<string[]> {
    try {
      const response = await invoke<string[]>("get_oauth_supported_remotes");

      console.log("Fetched OAuth-supported remotes:", response);
      return response;
    } catch (error) {
      console.error("❌ Failed to fetch OAuth-supported remotes:", error);
      return [];
    }
  }

  /** Get the configuration fields required for a specific remote type */
  async getRemoteConfigFields(type: string): Promise<any[]> {
    try {
      const response = await invoke<{ providers: any[] }>("get_remote_types");
      const provider = response.providers.find((p) => p.Name === type);
      return provider ? provider.Options : [];
    } catch (error) {
      console.error(`Failed to fetch config fields for ${type}:`, error);
      return [];
    }
  }

  async getRemotes(): Promise<string[]> {
    try {
      return await invoke<string[]>("get_remotes");
    } catch (error) {
      console.error("Failed to fetch remotes:", error);
      return [];
    }
  }

  async getDiskUsage(remoteName: string) {
    return await invoke<{
      total: string;
      used: string;
      free: string;
    }>("get_disk_usage", { remoteName: remoteName });
  }

  async getRemoteConfig(remoteName: string): Promise<any> {
    try {
      return await invoke<any>("get_remote_config", {
        remote_name: remoteName,
      });
    } catch (error) {
      console.error(`Failed to fetch config for remote ${remoteName}:`, error);
      return null;
    }
  }

  async getAllRemoteConfigs(): Promise<Record<string, any>> {
    try {
      console.log("Fetching all remote configs");
      return await invoke<Record<string, any>>("get_all_remote_configs");
    } catch (error) {
      console.error("Failed to fetch all remote configs:", error);
      return {};
    }
  }

  /** Create a new remote */
  async createRemote(
    name: string,
    parameters: Record<string, any>
  ): Promise<void> {
    await invoke("create_remote", { name, parameters }).catch((error) => {
      console.error(`Error creating remote ${name}:`, error);
    });
  }

    async quitOAuth() {
    try {
      await invoke("quit_rclone_oauth");
      console.log("OAuth process cancelled.");
    } catch (error) {
      console.error("Failed to cancel OAuth:", error);
    }
  }

  /** Update an existing remote */
  async updateRemote(
    name: string,
    parameters: Record<string, any>
  ): Promise<void> {
    await invoke("update_remote", { name, parameters }).catch((error) => {
      console.error(`Error updating remote ${name}:`, error);
    });
  }

  /** Delete a remote */
  async deleteRemote(name: string): Promise<void> {
    await invoke("delete_remote", { name }).catch((error) => {
      console.error(`Error deleting remote ${name}:`, error);
    });
  }

  /** List all mounted remotes */
  async listMounts(): Promise<string[]> {
    try {
      return await invoke<string[]>("list_mounts");
    } catch (error) {
      console.error("Failed to fetch mounts:", error);
      return [];
    }
  }

  async getMountedRemotes(): Promise<any[]> {
    try {
      return await invoke<string[]>("get_mounted_remotes");
    } catch (error) {
      console.error("Failed to fetch mounted remotes:", error);
    }
    return [];
  }

  /** Mount a remote */
  async mountRemote(remoteName: string, mountPoint: string): Promise<void> {
    try {
      await invoke("mount_remote", { remoteName, mountPoint });
      console.log("Mounted successfully");
    } catch (error) {
      console.error("Mount failed:", error);
    }
  }

  /** Unmount a remote */
  async unmountRemote(mountPoint: string): Promise<void> {
    try {
      await invoke("unmount_remote", { mountPoint });
      console.log("Unmounted successfully");
    } catch (error) {
      console.error("Unmount failed:", error);
    }
  }

  async getMountTypes(): Promise<string[]> {
    try {
      const response = await invoke("get_mount_types");
      return response as string[];
    } catch (error) {
      console.error("Error fetching mount types:", error);
      return [];
    }
  }

  /** Add a new mount configuration */
  async addMount(
    remote: string,
    mountPoint: string,
    options?: string
  ): Promise<void> {
    try {
      await invoke("add_mount", { remote, mount_point: mountPoint, options });
      console.log("Mount config added");
    } catch (error) {
      console.error("Failed to add mount config:", error);
    }
  }

  /** Remove a mount configuration */
  async removeMount(remote: string): Promise<void> {
    try {
      await invoke("remove_mount", { remote });
      console.log("Mount config removed");
    } catch (error) {
      console.error("Failed to remove mount config:", error);
    }
  }

  async saveMountConfig(
    remote: string,
    mountPath: string,
    options: Record<string, any>
  ): Promise<void> {
    console.log(
      "Saving mount config for",
      remote,
      "at",
      mountPath,
      "with options:",
      options
    );

    await invoke("save_mount_config", {
      remote: remote,
      mountPath: mountPath,
      options: options,
    }).catch((error) => {
      console.error(`Error saving mount config for ${remote}:`, error);
    });
  }

  async getSavedMountConfig(remoteName: string): Promise<any> {
    try {
      return await invoke<any>("get_saved_mount_config", {
        remote: remoteName,
      });
    } catch (error) {
      console.error("Error fetching mount config for", remoteName, ":", error);
      return null;
    }
  }

  // Get Flags

  async getGlobalFlags(): Promise<any> {
    try {
      return await invoke<any>("get_global_flags");
    } catch (error) {
      console.error("Error fetching global flags:", error);
      return null;
    }
  }

  async getCopyFlags(): Promise<any> {
    try {
      return await invoke<any>("get_copy_flags");
    } catch (error) {
      console.error("Error fetching copy flags:", error);
      return null;
    }
  }

  async getSyncFlags(): Promise<any> {
    try {
      return await invoke<any>("get_sync_flags");
    } catch (error) {
      console.error("Error fetching sync flags:", error);
      return null;
    }
  }

  async getFilterFlags(): Promise<any> {
    try {
      return await invoke<any>("get_filter_flags");
    } catch (error) {
      console.error("Error fetching filter flags:", error);
      return null;
    }
  }

  async getVfsFlags(): Promise<any> {
    try {
      return await invoke<any>("get_vfs_flags");
    } catch (error) {
      console.error("Error fetching vfs flags:", error);
      return null;
    }
  }

  async getMountFlags(): Promise<any> {
    try {
      return await invoke<any>("get_mount_flags");
    } catch (error) {
      console.error("Error fetching mount flags:", error);
      return null;
    }
  }
}
