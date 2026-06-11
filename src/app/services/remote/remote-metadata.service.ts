import { Injectable, inject, signal, computed, Signal } from '@angular/core';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { RemoteFileOperationsService } from '../remote/remote-file-operations.service';
import { FsInfo, RemoteFeatures, Origin } from '@app/types';
import { PathService } from '../infrastructure/platform/path.service';

@Injectable({ providedIn: 'root' })
export class RemoteMetadataService extends TauriBaseService {
  private readonly remoteOpsService = inject(RemoteFileOperationsService);
  private readonly pathService = inject(PathService);

  private readonly metadataCache = new Map<string, FsInfo>();
  private readonly _features = signal<Record<string, RemoteFeatures>>({});

  async getFsInfo(
    remoteName: string,
    source: Origin = 'dashboard',
    group?: string
  ): Promise<FsInfo> {
    const key = this.pathService.normalizeRemoteName(remoteName);
    if (this.metadataCache.has(key)) return this.metadataCache.get(key)!;

    const fsName = this.pathService.isLocalPath(key) ? key : `${key}:`;
    try {
      const info = await this.remoteOpsService.getFsInfo(fsName, source, group);
      this.metadataCache.set(key, info);
      return info;
    } catch (e) {
      console.error(e);
      throw e;
    }
  }

  getFeaturesSignal(remoteName: string): Signal<RemoteFeatures> {
    const key = this.pathService.normalizeRemoteName(remoteName);
    return computed(
      () =>
        this._features()[key] || {
          isLocal: this.pathService.isLocalPath(key),
          hasAbout: true,
          hasBucket: false,
          hasCleanUp: false,
          hasPublicLink: false,
          changeNotify: false,
          hashes: [],
        }
    );
  }

  async getFeatures(
    remoteName: string,
    source: Origin = 'dashboard',
    group?: string
  ): Promise<RemoteFeatures> {
    const key = this.pathService.normalizeRemoteName(remoteName);
    if (this._features()[key]) return this._features()[key];

    try {
      const info = await this.getFsInfo(remoteName, source, group);
      const feats: RemoteFeatures = {
        isLocal: this.pathService.isLocalPath(key),
        hasAbout: info.Features?.['About'] !== false,
        hasBucket: info.Features?.['BucketBased'] ?? false,
        hasCleanUp: !!info.Features?.['CleanUp'],
        hasPublicLink: info.Features?.['PublicLink'] !== false && !!info.Features?.['PublicLink'],
        changeNotify: !!info.Features?.['ChangeNotify'],
        hashes: info.Hashes ?? [],
      };
      this._features.update(c => ({ ...c, [key]: feats }));
      return feats;
    } catch {
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
      const key = this.pathService.normalizeRemoteName(remoteName);
      this.metadataCache.delete(key);
      this._features.update(c => {
        const n = { ...c };
        delete n[key];
        return n;
      });
    } else {
      this.metadataCache.clear();
      this._features.set({});
    }
  }
}
