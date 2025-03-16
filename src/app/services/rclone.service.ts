import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

@Injectable({
  providedIn: 'root'
})
export class RcloneService {

  constructor() { }

    /** Get all available remote types */
    async getRemoteTypes(): Promise<{ Name: string; Description: string }[]> {
      try {
        const response = await invoke<{ providers: { Name: string; Description: string }[] }>(
          "get_remote_types"
        );
        return response.providers;
      } catch (error) {
        console.error("Failed to fetch remote types:", error);
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
      return await invoke<string[]>('get_remotes');
    } catch (error) {
      console.error('Failed to fetch remotes:', error);
      return [];
    }
  }

  async getRemoteConfig(remoteName: string): Promise<any> {
    try {
      return await invoke<any>('get_remote_config', { remote_name: remoteName });
    } catch (error) {
      console.error(`Failed to fetch config for remote ${remoteName}:`, error);
      return null;
    }
  }

  async getAllRemoteConfigs(): Promise<Record<string, any>> {
    try {
      console.log('Fetching all remote configs');
      return await invoke<Record<string, any>>('get_all_remote_configs');
    } catch (error) {
      console.error('Failed to fetch all remote configs:', error);
      return {};
    }
  }

  /** List all mounted remotes */
  async listMounts(): Promise<string[]> {
    try {
      return await invoke<string[]>('list_mounts');
    } catch (error) {
      console.error('Failed to fetch mounts:', error);
      return [];
    }
  }

  /** Mount a remote */
  async mountRemote(remote: string, mountPoint: string): Promise<void> {
    try {
      await invoke('mount_remote', { remote, mountPoint });
      console.log('Mounted successfully');
    } catch (error) {
      console.error('Mount failed:', error);
    }
  }

  /** Unmount a remote */
  async unmountRemote(mountPoint: string): Promise<void> {
    try {
      await invoke('unmount_remote', { mountPoint });
      console.log('Unmounted successfully');
    } catch (error) {
      console.error('Unmount failed:', error);
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

  /** Fetch available mount options for a given mount type */
  async getMountOptions(): Promise<any[]> {
    try {
      const response = await invoke("get_mount_options");
      console.log("Mount options:", response);
      
      return response as any[];
    } catch (error) {
      console.error("Error fetching mount options:", error);
      return [];
    }
  }
  

  /** Add a new mount configuration */
  async addMount(remote: string, mountPoint: string, options?: string): Promise<void> {
    try {
      await invoke('add_mount', { remote, mount_point: mountPoint, options });
      console.log('Mount config added');
    } catch (error) {
      console.error('Failed to add mount config:', error);
    }
  }

  /** Remove a mount configuration */
  async removeMount(remote: string): Promise<void> {
    try {
      await invoke('remove_mount', { remote });
      console.log('Mount config removed');
    } catch (error) {
      console.error('Failed to remove mount config:', error);
    }
  }
}
