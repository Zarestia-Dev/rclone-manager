import { Injectable, inject, signal, computed, Signal } from '@angular/core';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { RemoteFileOperationsService } from './remote-file-operations.service';
import { PathService } from '../infrastructure/platform/path.service';
import { memoizedLoader, MemoizedLoader } from './utils/memoized-loader.util';
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
} from '@app/types';

interface RawProvider {
  Name: string;
  Description: string;
  Options?: RcConfigOption[];
}

type ProvidersResponse = Record<string, RawProvider[]>;

interface WriteRemoteOptions {
  successKey: string;
  successParams?: Record<string, string>;
  errorKey: string;
}

const EMPTY_HASHES: readonly string[] = Object.freeze([]);

@Injectable({ providedIn: 'root' })
export class RemoteManagementService extends TauriBaseService {
  private readonly remoteOpsService = inject(RemoteFileOperationsService);
  private readonly pathService = inject(PathService);

  private readonly metadataCache = new Map<string, FsInfo>();
  private readonly _features = signal<Record<string, RemoteFeatures>>({});
  private readonly _isLibrclone = signal<boolean | null>(null);

  private readonly featuresSignals = new Map<string, Signal<RemoteFeatures>>();

  private readonly providersLoader: MemoizedLoader<ProvidersResponse> = memoizedLoader(() =>
    this.invokeCommand<ProvidersResponse>('get_remote_types')
  );

  async getFsInfo(
    remoteName: string,
    source: Origin = 'dashboard',
    group?: string
  ): Promise<FsInfo> {
    const key = this.pathService.normalizeRemoteName(remoteName);
    const cached = this.metadataCache.get(key);
    if (cached !== undefined) return cached;

    const fsName = this.pathService.isLocalPath(key) ? key : `${key}:`;
    const info = await this.remoteOpsService.getFsInfo(fsName, source, group);
    this.metadataCache.set(key, info);
    return info;
  }

  getFeaturesSignal(remoteName: string, remoteType?: string): Signal<RemoteFeatures> {
    const nameKey = this.pathService.normalizeRemoteName(remoteName);
    const typeKey = remoteType ? remoteType.toLowerCase() : nameKey;
    const cacheKey = typeKey || nameKey;
    const existing = this.featuresSignals.get(cacheKey);
    if (existing) return existing;

    const sig = computed(
      () =>
        this._features()[cacheKey] ||
        this._features()[nameKey] || {
          IsLocal: this.pathService.isLocalPath(nameKey),
          About: true,
          BucketBased: false,
          CleanUp: false,
          PublicLink: false,
          ChangeNotify: false,
          Hashes: EMPTY_HASHES as string[],
          loading: true,
        }
    );
    this.featuresSignals.set(cacheKey, sig);
    return sig;
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

    // Async-load features so subsequent calls return accurate values
    void this.getFeatures(remoteName).catch(err =>
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

    this.setFeatures(nameKey, typeKey, true);

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
      this.setFeatures(nameKey, typeKey, feats);
      return feats;
    } catch {
      const fallback: RemoteFeatures = {
        IsLocal: this.pathService.isLocalPath(nameKey),
        About: false,
        BucketBased: false,
        CleanUp: false,
        PublicLink: false,
        ChangeNotify: false,
        Hashes: EMPTY_HASHES as string[],
        loading: false,
      };
      this.setFeatures(nameKey, typeKey, fallback);
      return fallback;
    }
  }

  private setFeatures(nameKey: string, typeKey: string, value: RemoteFeatures | true): void {
    const features: RemoteFeatures =
      value === true
        ? {
            IsLocal: this.pathService.isLocalPath(nameKey),
            About: false,
            BucketBased: false,
            CleanUp: false,
            PublicLink: false,
            ChangeNotify: false,
            Hashes: EMPTY_HASHES as string[],
            loading: true,
          }
        : value;
    this._features.update(c => ({ ...c, [nameKey]: features, [typeKey]: features }));
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
      this.featuresSignals.clear();
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
    return this.mapProviders(await this.providersLoader.load());
  }

  async getOAuthSupportedRemotes(): Promise<RemoteProvider[]> {
    return this.mapProviders(
      await this.invokeCommand<ProvidersResponse>('get_oauth_supported_remotes')
    );
  }

  async getRemoteConfigFields(type: string): Promise<RcConfigOption[]> {
    const response = await this.providersLoader.load();
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
    await this.writeRemote('create_remote', name, parameters, opt, {
      successKey: 'backendSuccess.remote.created',
      successParams: { name },
      errorKey: 'backendErrors.remote.configFailed',
    });
  }

  async updateRemote(
    name: string,
    parameters: ConfigRecord,
    opt?: Record<string, unknown>
  ): Promise<void> {
    await this.writeRemote('update_remote', name, parameters, opt, {
      successKey: 'backendSuccess.remote.updated',
      successParams: { name },
      errorKey: 'backendErrors.remote.configFailed',
    });
  }

  private async writeRemote(
    command: string,
    name: string,
    parameters: ConfigRecord,
    opt: Record<string, unknown> | undefined,
    options: WriteRemoteOptions
  ): Promise<void> {
    await this.invokeWithNotification(
      command,
      { name, parameters, ...(opt && { opt }) },
      {
        successKey: options.successKey,
        successParams: options.successParams,
        errorKey: options.errorKey,
      }
    );
  }

  async deleteRemote(name: string): Promise<void> {
    await this.invokeCommand('delete_remote', { name });
  }

  async isLibrclone(): Promise<boolean> {
    const cached = this._isLibrclone();
    if (cached !== null) return cached;
    try {
      const result = await this.invokeCommand<boolean>('is_librclone');
      this._isLibrclone.set(result);
      return result;
    } catch {
      this._isLibrclone.set(false);
      return false;
    }
  }

  /** Cancels an in-progress OAuth flow on the backend. */
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
      ...(parameters !== undefined && { parameters }),
      ...(opt !== undefined && { opt }),
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
      ...(parameters !== undefined && { parameters }),
      ...(opt !== undefined && { opt }),
    });
  }

  async obscureValue(cleartext: string): Promise<string> {
    return this.invokeCommand<string>('obscure_value', { clear: cleartext });
  }
}
