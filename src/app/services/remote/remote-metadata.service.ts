import { Injectable, inject } from '@angular/core';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { RemoteFileOperationsService } from '../remote/remote-file-operations.service';
import { FsInfo, RemoteFeatures, Origin } from '@app/types';

@Injectable({
  providedIn: 'root',
})
export class RemoteMetadataService extends TauriBaseService {
  private remoteOpsService = inject(RemoteFileOperationsService);

  private metadataCache = new Map<string, FsInfo>();
  private featuresCache = new Map<string, RemoteFeatures>();

  /**
   * Get and cache filesystem info for a remote
   */
  async getFsInfo(remoteName: string, source: Origin = 'dashboard'): Promise<FsInfo> {
    const fsName = remoteName.endsWith(':') ? remoteName : `${remoteName}:`;
    if (this.metadataCache.has(remoteName)) {
      const cached = this.metadataCache.get(remoteName);
      if (cached) return cached;
      throw new Error(`Metadata not found for ${remoteName}`); // Or handle appropriately
    }

    try {
      const info = await this.remoteOpsService.getFsInfo(fsName, source);
      this.metadataCache.set(remoteName, info);
      return info;
    } catch (error) {
      console.error(`[RemoteMetadataService] Error fetching info for ${remoteName}:`, error);
      throw error;
    }
  }

  /**
   * Extract and cache features for a remote
   */
  async getFeatures(remoteName: string, source: Origin = 'dashboard'): Promise<RemoteFeatures> {
    if (this.featuresCache.has(remoteName)) {
      const cached = this.featuresCache.get(remoteName);
      if (cached) return cached;
      throw new Error(`Features not found for ${remoteName}`); // Or handle appropriately
    }

    try {
      const info = await this.getFsInfo(remoteName, source);
      const features: RemoteFeatures = {
        isLocal: info.Features?.IsLocal ?? false,
        hasAbout: info.Features?.['About'] !== false, // Default to true unless explicitly false
        hasBucket: info.Features?.['BucketBased'] ?? false,
        hasCleanUp: !!info.Features?.['CleanUp'],
        hasPublicLink: info.Features?.['PublicLink'] !== false && !!info.Features?.['PublicLink'],
        changeNotify: !!info.Features?.['ChangeNotify'],
        hashes: info.Hashes ?? [],
      };
      this.featuresCache.set(remoteName, features);
      return features;
    } catch {
      // Fallback for failed feature detection
      return {
        isLocal: false,
        hasAbout: false,
        hasBucket: false,
        hasCleanUp: false,
        hasPublicLink: false,
        changeNotify: false,
        hashes: [],
      };
    }
  }

  clearCache(remoteName?: string): void {
    if (remoteName) {
      this.metadataCache.delete(remoteName);
      this.featuresCache.delete(remoteName);
    } else {
      this.metadataCache.clear();
      this.featuresCache.clear();
    }
  }
}
