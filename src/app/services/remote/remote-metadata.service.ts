import { Injectable, inject, signal, computed, Signal } from '@angular/core';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { RemoteFileOperationsService } from '../remote/remote-file-operations.service';
import { FsInfo, RemoteFeatures, Origin } from '@app/types';
import { PathService } from '../infrastructure/platform/path.service';

@Injectable({
  providedIn: 'root',
})
export class RemoteMetadataService extends TauriBaseService {
  private remoteOpsService = inject(RemoteFileOperationsService);
  private pathService = inject(PathService);

  private metadataCache = new Map<string, FsInfo>();
  private readonly _features = signal<Record<string, RemoteFeatures>>({});

  /**
   * Get and cache filesystem info for a remote
   */
  async getFsInfo(
    remoteName: string,
    source: Origin = 'dashboard',
    group?: string
  ): Promise<FsInfo> {
    const normalizedKey = this.pathService.normalizeRemoteName(remoteName);

    // Determine the proper fs name for rclone backend.
    // Local paths (starting with / or a Windows drive letter) shouldn't always have a colon appended.
    const isLocal = this.pathService.isLocalPath(normalizedKey);

    const fsName = isLocal ? normalizedKey : `${normalizedKey}:`;

    if (this.metadataCache.has(normalizedKey)) {
      const cached = this.metadataCache.get(normalizedKey);
      if (cached) return cached;
    }

    try {
      const info = await this.remoteOpsService.getFsInfo(fsName, source, group);
      this.metadataCache.set(normalizedKey, info);
      return info;
    } catch (error) {
      console.error(`[RemoteMetadataService] Error fetching info for ${normalizedKey}:`, error);
      throw error;
    }
  }

  /**
   * Get a signal for a specific remote's features
   */
  getFeaturesSignal(remoteName: string): Signal<RemoteFeatures> {
    const normalizedKey = this.pathService.normalizeRemoteName(remoteName);
    return computed(() => {
      return (
        this._features()[normalizedKey] ?? {
          isLocal: this.pathService.isLocalPath(normalizedKey),
          hasAbout: true,
          hasBucket: false,
          hasCleanUp: false,
          hasPublicLink: false,
          changeNotify: false,
          hashes: [],
        }
      );
    });
  }

  /**
   * Get and cache features for a remote
   */
  async getFeatures(
    remoteName: string,
    source: Origin = 'dashboard',
    group?: string
  ): Promise<RemoteFeatures> {
    const normalizedKey = this.pathService.normalizeRemoteName(remoteName);

    if (this._features()[normalizedKey]) {
      return this._features()[normalizedKey];
    }

    try {
      const info = await this.getFsInfo(remoteName, source, group);
      const features: RemoteFeatures = {
        isLocal: this.pathService.isLocalPath(normalizedKey),
        hasAbout: info.Features?.['About'] !== false, // Default to true unless explicitly false
        hasBucket: info.Features?.['BucketBased'] ?? false,
        hasCleanUp: !!info.Features?.['CleanUp'],
        hasPublicLink: info.Features?.['PublicLink'] !== false && !!info.Features?.['PublicLink'],
        changeNotify: !!info.Features?.['ChangeNotify'],
        hashes: info.Hashes ?? [],
      };
      this._features.update(cache => ({ ...cache, [normalizedKey]: features }));
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
      const key = this.pathService.normalizeRemoteName(remoteName);
      this.metadataCache.delete(key);
      this._features.update(cache => {
        const next = { ...cache };
        delete next[key];
        return next;
      });
    } else {
      this.metadataCache.clear();
      this._features.set({});
    }
  }
}
