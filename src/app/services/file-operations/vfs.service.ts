import { Injectable, inject } from '@angular/core';
import { ApiClientService } from '../core/api-client.service';

export interface VfsStats {
  diskCache?: {
    bytesUsed: number;
    erroredFiles: number;
    files: number;
    hashType: number;
    outOfSpace: boolean;
    path: string;
    pathMeta: string;
    uploadsInProgress: number;
    uploadsQueued: number;
  };
  fs: string;
  inUse: number;
  metadataCache: { dirs: number; files: number };
  opt: Record<string, unknown>;
}

export interface VfsList {
  vfses: string[];
}

export interface VfsQueueItem {
  name: string;
  size: number;
  id: number;
  expiry: number;
  tries: number;
  delay: number;
  uploading: boolean;
}

export interface VfsQueueResponse {
  queue: VfsQueueItem[];
}

export interface VfsPollIntervalResponse {
  enabled: boolean;
  interval: { raw: number; seconds: number; string: string };
  supported: boolean;
  timeout?: boolean;
}

export interface VfsForgetResponse {
  forgotten: string[];
}

@Injectable({ providedIn: 'root' })
export class VfsService {
  private apiClient = inject(ApiClientService);

  async listVfs(): Promise<VfsList> {
    try {
      return this.apiClient.invoke<VfsList>('vfs_list');
    } catch (error) {
      console.error('Error invoking vfs_list:', error);
      throw error;
    }
  }

  async forget(fs: string, file?: string): Promise<VfsForgetResponse> {
    try {
      return this.apiClient.invoke<VfsForgetResponse>('vfs_forget', { fs, file });
    } catch (error) {
      console.error('Error invoking vfs_forget:', error);
      throw error;
    }
  }

  async refresh(fs: string, dir?: string, recursive = false): Promise<void> {
    try {
      return this.apiClient.invoke('vfs_refresh', { fs, dir, recursive });
    } catch (error) {
      console.error('Error invoking vfs_refresh:', error);
      throw error;
    }
  }

  async getStats(fs: string): Promise<VfsStats> {
    try {
      return this.apiClient.invoke<VfsStats>('vfs_stats', { fs });
    } catch (error) {
      console.error('Error invoking vfs_stats:', error);
      throw error;
    }
  }

  async getQueue(fs: string): Promise<VfsQueueResponse> {
    try {
      return this.apiClient.invoke<VfsQueueResponse>('vfs_queue', { fs });
    } catch (error) {
      console.error('Error invoking vfs_queue:', error);
      throw error;
    }
  }

  async setPollInterval(fs: string, interval: string): Promise<VfsPollIntervalResponse> {
    try {
      return this.apiClient.invoke<VfsPollIntervalResponse>('vfs_poll_interval', { fs, interval });
    } catch (error) {
      console.error('Error invoking vfs_poll_interval:', error);
      throw error;
    }
  }

  async getPollInterval(fs: string): Promise<VfsPollIntervalResponse> {
    try {
      return this.apiClient.invoke<VfsPollIntervalResponse>('vfs_poll_interval', { fs });
    } catch (error) {
      console.error('Error invoking vfs_poll_interval:', error);
      throw error;
    }
  }

  async setQueueExpiry(fs: string, id: number, expiry: number, relative: boolean): Promise<void> {
    try {
      return this.apiClient.invoke('vfs_queue_set_expiry', { fs, id, expiry, relative });
    } catch (error) {
      console.error('Error invoking vfs_queue_set_expiry:', error);
      throw error;
    }
  }
}
