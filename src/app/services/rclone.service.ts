import { Injectable } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { InfoService } from "./info.service";

@Injectable({
  providedIn: "root",
})
export class RcloneService {
  constructor(private infoService: InfoService) {}

  openInFiles(mountPoint: string): Promise<void> {
    try {
      return invoke("open_in_files", { path: mountPoint });
    } catch (err) {
      console.error("Failed to open file manager:", err);
      return Promise.reject(err);
    }
  }

  selectFolder(require_empty?: boolean): Promise<string> {
    return invoke<string>("get_folder_location", {
      requireEmpty: require_empty,
    }).catch((err) => {
      console.error("Failed to open folder picker:", err);
      this.infoService.alertModal("Error", err);
      return Promise.reject(err);
    });
  }

  selectFile(): Promise<string> {
    return invoke<string>("get_file_location").catch((err) => {
      console.error("Failed to open file picker:", err);
      this.infoService.alertModal("Error", err);
      return Promise.reject(err);
    });
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
  async getOAuthSupportedRemotes(): Promise<
    { name: string; description: string }[]
  > {
    try {
      const response = await invoke<{
        [key: string]: { Name: string; Description: string }[];
      }>("get_oauth_supported_remotes");

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
      console.error("❌ Failed to fetch OAuth-supported remotes:", error);
      return [];
    }
  }

  /** Get the configuration fields required for a specific remote type */
  async getRemoteConfigFields(type: string): Promise<any[]> {
    try {
      const response = await invoke<{ providers: any[] }>("get_remote_types");
      const provider = response.providers.find((p) => p.Name === type);
      console.log(response);

      return provider ? provider.Options : [];
    } catch (error) {
      console.error(`Failed to fetch config fields for ${type}:`, error);
      return [];
    }
  }

  async getRemotes(): Promise<string[]> {
    try {
      // return await invoke<string[]>("get_remotes");
      return await invoke<string[]>("get_cached_remotes");
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

  async getAllRemoteConfigs(): Promise<Record<string, any>> {
    try {
      console.log("Fetching all remote configs");
      return await invoke<Record<string, any>>("get_configs");
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
    try {
      await invoke("create_remote", { name, parameters });
    } catch (error) {
      console.error(`Error creating remote ${name}:`, error);
    }
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
    console.log("Updating remote:", name, parameters);
    await invoke("update_remote", {
      name,
      parameters,
    }).catch((error) => {
      console.error(`Error updating remote ${name}:`, error);
    });
  }

  /** Delete a remote */
  async deleteRemote(name: string): Promise<void> {
    await invoke("delete_remote", { name }).catch((error) => {
      console.error(`Error deleting remote ${name}:`, error);
    });
    await invoke("delete_remote_settings", { remoteName: name }).catch(
      (error) => {
        console.error(`Error deleting saved mount config for ${name}:`, error);
      }
    );
    console.log(`Remote ${name} deleted successfully.`);
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
      return await invoke<string[]>("get_cached_mounted_remotes");
    } catch (error) {
      console.error("Failed to fetch mounted remotes:", error);
    }
    return [];
  }

  /** Mount a remote */
  async mountRemote(
    remoteName: string,
    mountPoint: string,
    mountOptions?: Record<string, string | number | boolean>,
    vfsOptions?: Record<string, string | number | boolean>
  ): Promise<void> {
    try {
      await invoke("mount_remote", {
        remoteName: remoteName,
        mountPoint: mountPoint,
        mountOptions: mountOptions,
        vfsOptions: vfsOptions,
      });
    } catch (error) {
      this.infoService.openSnackBar(String(error), "Close");
      console.error("Mount failed:", error);
    }
  }

  /** Unmount a remote */
  async unmountRemote(mountPoint: string, remoteName: string): Promise<void> {
    try {
      await invoke("unmount_remote", { mountPoint, remoteName });
      console.log("Unmounted successfully");
    } catch (error) {
      this.infoService.openSnackBar(String(error), "Close");
      console.error("Unmount failed:", error);
    }
  }

  async startSync(
    source: string,
    destination: string,
    syncOptions: Record<string, any>,
    filterOptions: Record<string, any>
  ): Promise<void> {
    try {
      return await invoke("start_sync", {
        source: source,
        destination: destination,
        syncOptions: syncOptions,
        filterOptions: filterOptions,
      });
    } catch (error) {
      console.error("Sync failed:", error);
    }
  }

  async startCopy(
    source: string,
    destination: string,
    copyOptions: Record<string, any>,
    filterOptions: Record<string, any>
  ): Promise<void> {
    return await (
      invoke("start_copy", {
        source: source,
        destination: destination,
        copyOptions: copyOptions,
        filterOptions: filterOptions,
      }) as Promise<void>
    ).catch((error) => {
      console.error("Copy failed:", error);
    });
  }

  async getFsInfo(remoteName: string): Promise<any> {
    try {
      return await invoke<any>("get_fs_info", { remoteName });
    } catch (error) {
      console.error("Error fetching fs info:", error);
      return null;
    }
  }

  async getRemotePaths(
    remote: string,
    path: string,
    options: Record<string, any>
  ): Promise<any> {
    try {
      return await invoke<any>("get_remote_paths", {
        remote,
        path,
        options,
      });
    } catch (error) {
      console.error("Error fetching remote paths:", error);
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

  // Get Logs
  async getRemoteLogs(remoteName: string): Promise<string[]> {
    try {
      return await invoke<string[]>("get_remote_logs", { remoteName });
    } catch (error) {
      console.error("Error fetching remote logs:", error);
      return [];
    }
  }

  async getRemoteErrors(remoteName: string): Promise<string[]> {
    try {
      return await invoke<string[]>("get_remote_errors", { remoteName });
    } catch (error) {
      console.error("Error fetching remote errors:", error);
      return [];
    }
  }

  async clearRemoteLogs(remoteName: string): Promise<void> {
    try {
      await invoke("clear_logs_for_remote", { remoteName });
      console.log(`Logs for ${remoteName} cleared successfully.`);
    } catch (error) {
      console.error("Error clearing remote logs:", error);
    }
  }

  async clearRemoteErrors(remoteName: string): Promise<void> {
    try {
      await invoke("clear_errors_for_remote", { remoteName });
      console.log(`Errors for ${remoteName} cleared successfully.`);
    } catch (error) {
      console.error("Error clearing remote errors:", error);
    }
  }
}
