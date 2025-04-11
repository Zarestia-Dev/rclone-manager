import { Injectable } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { ConfirmDialogData, ConfirmModalComponent } from "../modals/confirm-modal/confirm-modal.component";
import { MatDialog } from "@angular/material/dialog";

@Injectable({
  providedIn: "root",
})
export class RcloneService {
  constructor(
    private dialog: MatDialog // Inject MatDialog for opening modals
  ) {}

    alertModal(title: string, message: string) {
      // Create the confirmation dialog data
      const dialogData: ConfirmDialogData = {
        title: title,
        message: message,
        cancelText: "OK",
      };
  
      // Open the confirmation dialog
      this.dialog.open(ConfirmModalComponent, {
        width: "300px",
        data: dialogData,
      });
    }

  openInFiles(mountPoint: string): Promise<void> {
    try {
      return invoke("open_in_files", { path: mountPoint });
    } catch (err) {
      console.error("Failed to open file manager:", err);
      return Promise.reject(err);
    }
  }

  selectFolder(is_empty?: boolean): Promise<string> {
      return invoke<string>("get_folder_location", {
        isEmpty: is_empty,
      }).catch((err) => {
        console.error("Failed to open folder picker:", err);
        this.alertModal("Error", err);
        return Promise.reject(err);
      });
  }

  selectFile(): Promise<string> {
    return invoke<string>("get_file_location").catch((err) => {
      console.error("Failed to open file picker:", err);
      this.alertModal("Error", err);
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
      return await invoke<Record<string, any>>("get_configs"); // ✅ Updated to use get_configs
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
    await invoke("unmount_remote", { mountPoint: name }).catch((error) => {
      console.error(`Error unmounting remote ${name}:`, error);
    });
    await invoke("delete_remote", { name }).catch((error) => {
      console.error(`Error deleting remote ${name}:`, error);
    });
    await invoke("delete_remote_settings", { remoteName: name }).catch(
      (error) => {
        console.error(`Error deleting saved mount config for ${name}:`, error);
      }
    );
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
  async mountRemote(
    remoteName: string,
    mountPoint: string,
    mount_options?: Record<string, string | number | boolean>,
    vfs_options?: Record<string, string | number | boolean>
  ): Promise<void> {
    try {        
      if (!mountPoint) {
        console.error("Mount point is required");
        this.alertModal(
          "Mount Point Required",
          "Please Add a mount point to continue."
        );
        return;
      }
      await invoke("mount_remote", {
        remoteName,
        mountPoint,
        mount_options,
        vfs_options,
      });
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

  async startSync(
    source: string,
    destination: string,
    syncOptions: Record<string, any>,
    filterOptions: Record<string, any>
  ): Promise<void> {
    try {
      return await invoke("start_sync", {
        source : source,
        destination : destination,
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
    return await (invoke("start_copy", {
      source: source,
      destination: destination,
      copyOptions: copyOptions,
      filterOptions: filterOptions,
    }) as Promise<void>).catch((error) => {
      console.error("Copy failed:", error);
    });
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
