import { Injectable, inject, signal, computed, untracked, Signal } from '@angular/core';
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
  createDefaultRemoteFeatures,
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

@Injectable({ providedIn: 'root' })
export class RemoteManagementService extends TauriBaseService {
  private readonly remoteOpsService = inject(RemoteFileOperationsService);
  private readonly pathService = inject(PathService);

  private readonly metadataCache = new Map<string, FsInfo>();
  private readonly _features = signal<Record<string, RemoteFeatures>>({});
  private readonly _isLibrclone = signal<boolean | null>(null);

  private readonly featuresSignals = new Map<string, Signal<RemoteFeatures>>();
  private readonly inFlightFeatures = new Map<string, Promise<RemoteFeatures>>();

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
    const cacheKey = nameKey || typeKey;
    const isLocal = this.pathService.isLocalPath(nameKey);

    if (nameKey && !isLocal) {
      untracked(() => {
        const cached = this._features()[cacheKey];
        if (!cached && !this.inFlightFeatures.has(cacheKey)) {
          void this.getFeatures(remoteName, remoteType).catch(err =>
            console.error(`Failed to load features for ${remoteName}:`, err)
          );
        }
      });
    }

    const existing = this.featuresSignals.get(cacheKey);
    if (existing) return existing;

    const sig = computed(
      () => this._features()[cacheKey] || createDefaultRemoteFeatures(isLocal, !isLocal)
    );
    this.featuresSignals.set(cacheKey, sig);
    return sig;
  }

  hasFeature(
    remoteName: string,
    feature: keyof RemoteFeatures | string,
    remoteType?: string
  ): boolean {
    const feats = this.getFeaturesSignal(remoteName, remoteType)();
    return !feats.loading && !!feats[feature];
  }

  publicLinkSupported(remoteName: string): boolean {
    return this.hasFeature(remoteName, 'PublicLink');
  }

  async getFeatures(
    remoteName: string,
    remoteType?: string,
    source: Origin = 'dashboard',
    group?: string
  ): Promise<RemoteFeatures> {
    const nameKey = this.pathService.normalizeRemoteName(remoteName);
    const typeKey = remoteType ? remoteType.toLowerCase() : nameKey;
    const cacheKey = nameKey || typeKey;

    const cached = untracked(() => this._features()[cacheKey]);
    if (cached && !cached.loading) return cached;

    const existingPromise = this.inFlightFeatures.get(cacheKey);
    if (existingPromise) return existingPromise;

    const promise = (async (): Promise<RemoteFeatures> => {
      try {
        const info = await this.getFsInfo(remoteName, source, group);
        const isLocal = this.pathService.isLocalPath(nameKey) || !!info.Features?.['IsLocal'];
        const feats: RemoteFeatures = {
          ...createDefaultRemoteFeatures(isLocal, false),
          ...(info.Features as Record<string, boolean | undefined>),
          IsLocal: isLocal,
          Hashes: info.Hashes ?? [],
          loading: false,
        };
        this.setFeatures(nameKey, typeKey, feats);
        return feats;
      } catch {
        const fallback = createDefaultRemoteFeatures(this.pathService.isLocalPath(nameKey), false);
        this.setFeatures(nameKey, typeKey, fallback);
        return fallback;
      } finally {
        this.inFlightFeatures.delete(cacheKey);
      }
    })();

    this.inFlightFeatures.set(cacheKey, promise);
    return promise;
  }

  private setFeatures(nameKey: string, typeKey: string, features: RemoteFeatures): void {
    this._features.update(c => {
      const next = { ...c };
      if (nameKey) next[nameKey] = features;
      if (typeKey && !nameKey) next[typeKey] = features;
      return next;
    });
  }

  clearCache(remoteName?: string): void {
    if (remoteName) {
      const key = this.pathService.normalizeRemoteName(remoteName);
      this.metadataCache.delete(key);
      this.inFlightFeatures.delete(key);
      this.featuresSignals.delete(key);
      this._features.update(c => {
        const n = { ...c };
        delete n[key];
        return n;
      });
    } else {
      this.metadataCache.clear();
      this.inFlightFeatures.clear();
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
