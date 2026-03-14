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
    const normalizedKey = remoteName.endsWith(':') ? remoteName.slice(0, -1) : remoteName;
    const fsName = `${normalizedKey}:`;

    if (this.metadataCache.has(normalizedKey)) {
      const cached = this.metadataCache.get(normalizedKey);
      if (cached) return cached;
      throw new Error(`Metadata not found for ${normalizedKey}`);
    }

    try {
      const info = await this.remoteOpsService.getFsInfo(fsName, source);
      this.metadataCache.set(normalizedKey, info);
      return info;
    } catch (error) {
      console.error(`[RemoteMetadataService] Error fetching info for ${normalizedKey}:`, error);
      throw error;
    }
  }

  /**
   * Extract and cache features for a remote
   */
  async getFeatures(remoteName: string, source: Origin = 'dashboard'): Promise<RemoteFeatures> {
    const normalizedKey = remoteName.endsWith(':') ? remoteName.slice(0, -1) : remoteName;

    if (this.featuresCache.has(normalizedKey)) {
      const cached = this.featuresCache.get(normalizedKey);
      if (cached) return cached;
      throw new Error(`Features not found for ${normalizedKey}`);
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
    } catch (error) {
      // Fallback for failed feature detection
      return {
        isLocal: false,
        hasAbout: false,
        hasBucket: false,
        hasCleanUp: false,
        hasPublicLink: false,
        changeNotify: false,
        hashes: [],
        error: String(error),
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
