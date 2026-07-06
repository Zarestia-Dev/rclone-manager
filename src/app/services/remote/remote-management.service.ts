import { Injectable, inject, signal, computed, Signal } from '@angular/core';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { RemoteFileOperationsService } from './remote-file-operations.service';
import { PathService } from '../infrastructure/platform/path.service';
import {
  RemoteProvider,
  ConfigRecord,
  RcConfigOption,
  RcConfigQuestionResponse,
  LocalDrive,
  CommandOption,
  INTERACTIVE_REMOTES,
  FsInfo,
  RemoteFeatures,
  Origin,
  CompletedTransfer,
} from '@app/types';

interface RawProvider {
  Name: string;
  Description: string;
  Options?: RcConfigOption[];
}

type ProvidersResponse = Record<string, RawProvider[]>;

@Injectable({ providedIn: 'root' })
export class RemoteManagementService extends TauriBaseService {
  private readonly remoteOpsService = inject(RemoteFileOperationsService);
  private readonly pathService = inject(PathService);

  private readonly metadataCache = new Map<string, FsInfo>();
  private readonly _features = signal<Record<string, RemoteFeatures>>({});
  private readonly _isLibrclone = signal<boolean>(false);

  async getFsInfo(
    remoteName: string,
    source: Origin = 'dashboard',
    group?: string
  ): Promise<FsInfo> {
    const key = this.pathService.normalizeRemoteName(remoteName);
    const cached = this.metadataCache.get(key);
    if (cached !== undefined) return cached;

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

  getFeaturesSignal(remoteName: string, remoteType?: string): Signal<RemoteFeatures> {
    const nameKey = this.pathService.normalizeRemoteName(remoteName);
    const typeKey = remoteType ? remoteType.toLowerCase() : nameKey;
    return computed(
      () =>
        this._features()[typeKey] ||
        this._features()[nameKey] || {
          IsLocal: this.pathService.isLocalPath(nameKey),
          About: true,
          BucketBased: false,
          CleanUp: false,
          PublicLink: false,
          ChangeNotify: false,
          Hashes: [],
          loading: true,
        }
    );
  }

  publicLinkSupported(remoteName: string): boolean {
    const nameKey = this.pathService.normalizeRemoteName(remoteName);
    if (!nameKey || this.pathService.isLocalPath(nameKey)) {
      return false;
    }

    const cached = this._features()[nameKey];
    if (cached) {
      return !!cached.PublicLink;
    }

    // Trigger asynchronous load in background
    this.getFeatures(remoteName).catch(err =>
      console.error(`Failed to load features for ${remoteName}:`, err)
    );

    return false;
  }

  async getFeatures(
    remoteName: string,
    remoteType?: string,
    source: Origin = 'dashboard',
    group?: string
  ): Promise<RemoteFeatures> {
    const nameKey = this.pathService.normalizeRemoteName(remoteName);
    const typeKey = remoteType ? remoteType.toLowerCase() : nameKey;

    const cached = this._features()[typeKey] || this._features()[nameKey];
    if (cached && !cached.loading) return cached;

    const loadingState: RemoteFeatures = {
      IsLocal: this.pathService.isLocalPath(nameKey),
      About: false,
      BucketBased: false,
      CleanUp: false,
      PublicLink: false,
      ChangeNotify: false,
      Hashes: [],
      loading: true,
    };
    this._features.update(c => ({ ...c, [nameKey]: loadingState, [typeKey]: loadingState }));

    try {
      const info = await this.getFsInfo(remoteName, source, group);
      const feats: RemoteFeatures = {
        IsLocal: this.pathService.isLocalPath(nameKey),
        About: info.Features?.['About'] === true,
        BucketBased: info.Features?.['BucketBased'] ?? false,
        CleanUp: !!info.Features?.['CleanUp'],
        PublicLink: info.Features?.['PublicLink'] !== false && !!info.Features?.['PublicLink'],
        ChangeNotify: !!info.Features?.['ChangeNotify'],
        Hashes: info.Hashes ?? [],
        loading: false,
      };
      this._features.update(c => ({ ...c, [nameKey]: feats, [typeKey]: feats }));
      return feats;
    } catch {
      const fallback: RemoteFeatures = {
        IsLocal: this.pathService.isLocalPath(nameKey),
        About: false,
        BucketBased: false,
        CleanUp: false,
        PublicLink: false,
        ChangeNotify: false,
        Hashes: [],
        loading: false,
      };
      this._features.update(c => ({ ...c, [nameKey]: fallback, [typeKey]: fallback }));
      return fallback;
    }
  }

  resolvePublicLinkTarget(
    item: CompletedTransfer,
    jobType?: string,
    activeRemote?: string
  ): { remote: string; path: string } | null {
    // If the transfer failed, we cannot generate a public link
    if (item.status === 'failed') {
      return null;
    }

    const getRemoteName = (fs: string): string => {
      if (!fs || this.pathService.isLocalPath(fs)) return '';
      const parts = fs.split(':');
      if (parts.length > 1) {
        const name = parts[0];
        if (name === 'http' || name === 'https' || name === 'ftp') return '';
        return name;
      }
      return '';
    };

    const dstRemote = getRemoteName(item.dstFs || '');
    const srcRemote = getRemoteName(item.srcFs || '');

    const isDeleteOrCleanup = (): boolean => {
      const type = jobType?.toLowerCase() || '';
      if (type === 'delete' || type === 'cleanup' || type === 'rmdirs') {
        return true;
      }
      if (item.group) {
        const groupType = item.group.split('/')[0]?.toLowerCase();
        if (
          groupType === 'move' ||
          groupType === 'delete' ||
          groupType === 'cleanup' ||
          groupType === 'rmdirs'
        ) {
          return true;
        }
      }
      return false;
    };

    const isMove = (): boolean => {
      const type = jobType?.toLowerCase() || '';
      if (type === 'move') return true;
      if (item.group) {
        const groupType = item.group.split('/')[0]?.toLowerCase();
        if (groupType === 'move') return true;
      }
      return false;
    };

    // If it's a delete/cleanup job, the file is deleted. No public link possible.
    if (isDeleteOrCleanup()) {
      return null;
    }

    // Determine target based on transfer status and job type
    if (item.status === 'missing_dst') {
      // File only exists on source
      if (srcRemote && this.publicLinkSupported(srcRemote)) {
        return { remote: item.srcFs || '', path: item.name };
      }
    } else if (item.status === 'missing_src') {
      // File only exists on destination
      if (dstRemote && this.publicLinkSupported(dstRemote)) {
        return { remote: item.dstFs || '', path: item.name };
      }
    } else {
      // For completed, checked, partial, etc.

      // If it's a move, the file was deleted from source and exists only at the destination.
      // So we can only get public link from destination.
      if (isMove()) {
        if (dstRemote && this.publicLinkSupported(dstRemote)) {
          return { remote: item.dstFs || '', path: item.name };
        }
        return null;
      }

      // For copy/sync/check, file is on both (or we check destination first, then source)
      if (dstRemote && this.publicLinkSupported(dstRemote)) {
        return { remote: item.dstFs || '', path: item.name };
      }

      if (srcRemote && this.publicLinkSupported(srcRemote)) {
        return { remote: item.srcFs || '', path: item.name };
      }

      // Fallback: If both dstFs and srcFs are empty/falsy, check active remote
      if (!item.dstFs && !item.srcFs && activeRemote) {
        const fallbackRemote = this.pathService.normalizeRemoteName(activeRemote);
        if (fallbackRemote && this.publicLinkSupported(fallbackRemote)) {
          return {
            remote: this.pathService.normalizeRemoteForRclone(activeRemote),
            path: item.name,
          };
        }
      }
    }

    return null;
  }

  resolveDownloadRemote(item: CompletedTransfer, activeRemote?: string): string {
    const getRemoteName = (fs: string): string => {
      if (!fs || this.pathService.isLocalPath(fs)) return '';
      const parts = fs.split(':');
      if (parts.length > 1) {
        const name = parts[0];
        if (name === 'http' || name === 'https' || name === 'ftp') return '';
        return name;
      }
      return '';
    };

    const dstFs = item.dstFs || '';
    const srcFs = item.srcFs || '';

    if (getRemoteName(dstFs)) {
      return dstFs;
    }
    if (getRemoteName(srcFs)) {
      return srcFs;
    }

    if (!dstFs && !srcFs && activeRemote) {
      const fallback = this.pathService.normalizeRemoteForRclone(activeRemote);
      if (!this.pathService.isLocalPath(fallback)) {
        return fallback;
      }
    }

    return dstFs || srcFs || '';
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

  private providersCache: ProvidersResponse | null = null;
  private providersPromise: Promise<ProvidersResponse> | null = null;

  private async fetchProviders(): Promise<ProvidersResponse> {
    if (this.providersCache) return this.providersCache;
    if (this.providersPromise) return this.providersPromise;

    this.providersPromise = this.invokeCommand<ProvidersResponse>('get_remote_types');
    try {
      this.providersCache = await this.providersPromise;
      return this.providersCache;
    } finally {
      this.providersPromise = null;
    }
  }

  isInteractiveRemote(type: string): boolean {
    return INTERACTIVE_REMOTES.has(type.toLowerCase());
  }

  buildOpt(userOptions: CommandOption[]): Record<string, unknown> {
    return Object.fromEntries(userOptions.map(o => [o.key, o.value]));
  }

  private mapProviders(response: ProvidersResponse): RemoteProvider[] {
    return Object.values(response)
      .flat()
      .map(p => ({ name: p.Name, description: p.Description }));
  }

  async getRemoteTypes(): Promise<RemoteProvider[]> {
    return this.mapProviders(await this.fetchProviders());
  }

  async getOAuthSupportedRemotes(): Promise<RemoteProvider[]> {
    return this.mapProviders(
      await this.invokeCommand<ProvidersResponse>('get_oauth_supported_remotes')
    );
  }

  async getRemoteConfigFields(type: string): Promise<RcConfigOption[]> {
    const response = await this.fetchProviders();
    const match = Object.values(response)
      .flat()
      .find(p => p.Name === type);
    return match?.Options ?? [];
  }

  async getRemotes(): Promise<string[]> {
    return this.invokeCommand<string[]>('get_cached_remotes');
  }

  async getAllRemoteConfigs(): Promise<Record<string, unknown>> {
    return this.invokeCommand<Record<string, unknown>>('get_configs');
  }

  async createRemote(
    name: string,
    parameters: ConfigRecord,
    opt?: Record<string, unknown>
  ): Promise<void> {
    await this.invokeWithNotification(
      'create_remote',
      { name, parameters, ...(opt && { opt }) },
      {
        successKey: 'backendSuccess.remote.created',
        successParams: { name },
        errorKey: 'backendErrors.remote.configFailed',
      }
    );
  }

  async updateRemote(
    name: string,
    parameters: ConfigRecord,
    opt?: Record<string, unknown>
  ): Promise<void> {
    await this.invokeWithNotification(
      'update_remote',
      { name, parameters, ...(opt && { opt }) },
      {
        successKey: 'backendSuccess.remote.updated',
        successParams: { name },
        errorKey: 'backendErrors.remote.configFailed',
      }
    );
  }

  async deleteRemote(name: string): Promise<void> {
    await this.invokeCommand('delete_remote', { name });
  }

  async isLibrclone(): Promise<boolean> {
    if (this._isLibrclone() !== null) {
      return this._isLibrclone();
    }
    try {
      const result = await this.invokeCommand<boolean>('is_librclone');
      this._isLibrclone.set(result);
      return result;
    } catch {
      this._isLibrclone.set(false);
      return false;
    }
  }

  async quitOAuth(): Promise<void> {
    return this.invokeCommand('cancel_oauth');
  }

  async getLocalDrives(): Promise<LocalDrive[]> {
    return this.invokeCommand<LocalDrive[]>('get_local_drives');
  }

  async startRemoteConfigInteractive(
    name: string,
    type: string,
    parameters?: Record<string, unknown>,
    opt?: Record<string, unknown>
  ): Promise<RcConfigQuestionResponse> {
    return this.invokeCommand('create_remote_interactive', {
      name,
      rcloneType: type,
      ...(parameters && { parameters }),
      ...(opt && { opt }),
    });
  }

  async continueRemoteConfigInteractive(
    name: string,
    stateToken: string,
    result: unknown,
    parameters?: Record<string, unknown>,
    opt?: Record<string, unknown>
  ): Promise<RcConfigQuestionResponse> {
    return this.invokeCommand('continue_create_remote_interactive', {
      name,
      stateToken,
      result,
      ...(parameters && { parameters }),
      ...(opt && { opt }),
    });
  }

  async obscureValue(clear: string): Promise<string> {
    return this.invokeCommand<string>('obscure_value', { clear });
  }
}
