import { Injectable } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';

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
export class VfsService extends TauriBaseService {
  async listVfs(): Promise<VfsList> {
    return this.invokeCommand<VfsList>('vfs_list');
  }

  async forget(fs: string, file?: string): Promise<VfsForgetResponse> {
    return this.invokeCommand<VfsForgetResponse>('vfs_forget', { fs, file });
  }

  async refresh(fs: string, dir?: string, recursive = false): Promise<void> {
    return this.invokeCommand('vfs_refresh', { fs, dir, recursive });
  }

  async getStats(fs: string): Promise<VfsStats> {
    return this.invokeCommand<VfsStats>('vfs_stats', { fs });
  }

  async getQueue(fs: string): Promise<VfsQueueResponse> {
    return this.invokeCommand<VfsQueueResponse>('vfs_queue', { fs });
  }

  async setPollInterval(fs: string, interval: string): Promise<VfsPollIntervalResponse> {
    return this.invokeCommand<VfsPollIntervalResponse>('vfs_poll_interval', { fs, interval });
  }

  async getPollInterval(fs: string): Promise<VfsPollIntervalResponse> {
    return this.invokeCommand<VfsPollIntervalResponse>('vfs_poll_interval', { fs });
  }

  async setQueueExpiry(fs: string, id: number, expiry: number, relative: boolean): Promise<void> {
    return this.invokeCommand('vfs_queue_set_expiry', { fs, id, expiry, relative });
  }
}
