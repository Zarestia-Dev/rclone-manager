import {
  Injectable,
  inject,
  signal,
  computed,
  untracked,
  Signal,
  WritableSignal,
  DestroyRef,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { VaultService } from '../security/vault.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { RemoteFileOperationsService } from './remote-file-operations.service';
import { PathService } from '../infrastructure/platform/path.service';
import { DeferredTaskQueue } from 'src/app/shared/utils/deferred-task-queue.util';
import { abortableRequest, isAbortError } from 'src/app/shared/utils/abortable-request.util';
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

interface RemoteMetadataState {
  info: WritableSignal<FsInfo | undefined>;
  failed: WritableSignal<boolean>;
  features: Signal<RemoteFeatures>;
  request?: { controller: AbortController; promise: Promise<FsInfo> };
}

interface WriteRemoteOptions {
  successKey: string;
  successParams?: Record<string, string>;
  errorKey: string;
}

@Injectable({ providedIn: 'root' })
export class RemoteManagementService extends TauriBaseService {
  private readonly remoteOpsService = inject(RemoteFileOperationsService);
  private readonly pathService = inject(PathService);
  private readonly vault = inject(VaultService);
  private readonly events = inject(EventListenersService);

  private scope = new AbortController();
  private configRequest?: Promise<Record<string, unknown>>;
  private readonly metadata = new Map<string, RemoteMetadataState>();
  private readonly featureQueue = new DeferredTaskQueue();

  constructor() {
    super();
    this.events
      .listenToBackendSwitched()
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.resetScope());
    this.events
      .listenToVaultState()
      .pipe(takeUntilDestroyed())
      .subscribe(state => {
        if (state.isLocked) this.resetScope();
      });
    inject(DestroyRef).onDestroy(() => {
      this.featureQueue.destroy();
      this.resetScope();
    });
  }

  private resetScope(): void {
    this.scope.abort();
    this.scope = new AbortController();
    this.configRequest = undefined;
    this.providersLoader.invalidate();
    this.clearCache();
    this.pathService.setRemoteNames([]);
  }

  private getMetadata(key: string): RemoteMetadataState {
    let state = this.metadata.get(key);
    if (!state) {
      const info = signal<FsInfo | undefined>(undefined);
      const failed = signal(false);
      const features = computed(() => {
        const value = info();
        const isLocal = this.pathService.isLocalPath(key);
        return value
          ? this.featuresFromInfo(key, value)
          : createDefaultRemoteFeatures(isLocal, !isLocal && !failed());
      });
      state = { info, failed, features };
      this.metadata.set(key, state);
    }
    return state;
  }

  private featuresFromInfo(key: string, info: FsInfo): RemoteFeatures {
    const isLocal = this.pathService.isLocalPath(key) || !!info.Features?.['IsLocal'];
    return {
      ...createDefaultRemoteFeatures(isLocal),
      ...info.Features,
      IsLocal: isLocal,
      Hashes: info.Hashes ?? [],
      loading: false,
    };
  }

  private readonly providersLoader: MemoizedLoader<ProvidersResponse> = memoizedLoader(() =>
    this.invokeCommand<ProvidersResponse>('get_remote_types')
  );

  async getFsInfo(
    remoteName: string,
    source: Origin = 'dashboard',
    group?: string
  ): Promise<FsInfo> {
    const key = this.pathService.normalizeRemoteName(remoteName);
    const state = this.getMetadata(key);
    const cached = untracked(state.info);
    if (cached !== undefined) return cached;
    if (state.request) return state.request.promise;
    this.featureQueue.clear(key);
    const controller = new AbortController();
    const fsName = this.pathService.isLocalPath(key) ? key : `${key}:`;
    const promise = abortableRequest(controller.signal, () =>
      this.remoteOpsService.getFsInfo(fsName, source, group)
    )
      .then(info => {
        if (controller.signal.aborted) throw new DOMException('Request superseded', 'AbortError');
        state.info.set(info);
        return info;
      })
      .catch(error => {
        if (!controller.signal.aborted) state.failed.set(true);
        throw error;
      })
      .finally(() => {
        if (state.request?.controller === controller) state.request = undefined;
      });
    state.failed.set(false);
    state.request = { controller, promise };
    return promise;
  }

  getFeaturesSignal(remoteName: string): Signal<RemoteFeatures> {
    const key = this.pathService.normalizeRemoteName(remoteName);
    const state = this.getMetadata(key);
    if (this.vault.isAccessible()) {
      untracked(() => {
        if (key && state.features().loading && !state.request) {
          this.featureQueue.enqueue(key, async () => {
            if (this.vault.isAccessible()) return this.getFsInfo(remoteName);
            return undefined;
          });
        }
      });
    }
    return state.features;
  }

  hasFeature(remoteName: string, feature: keyof RemoteFeatures | string): boolean {
    const features = this.getFeaturesSignal(remoteName)();
    return !features.loading && !!features[feature];
  }

  async getFeatures(
    remoteName: string,
    options: { source?: Origin; group?: string } = {}
  ): Promise<RemoteFeatures> {
    const key = this.pathService.normalizeRemoteName(remoteName);
    const state = this.getMetadata(key);
    try {
      await this.getFsInfo(remoteName, options.source, options.group);
      return untracked(state.features);
    } catch (error) {
      if (isAbortError(error)) throw error;
      return createDefaultRemoteFeatures(this.pathService.isLocalPath(key));
    }
  }

  clearCache(remoteName?: string): void {
    const key =
      remoteName !== undefined ? this.pathService.normalizeRemoteName(remoteName) : undefined;
    this.featureQueue.clear(key);
    const entries =
      key !== undefined ? [[key, this.metadata.get(key)] as const] : this.metadata.entries();
    for (const [, state] of entries) {
      if (!state) continue;
      const request = state.request;
      state.request = undefined;
      request?.controller.abort();
      state.info.set(undefined);
      state.failed.set(false);
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
    return abortableRequest(this.scope.signal, () =>
      this.invokeCommand<string[]>('get_cached_remotes')
    );
  }

  async getAllRemoteConfigs(): Promise<Record<string, unknown>> {
    if (this.configRequest) return this.configRequest;
    const scope = this.scope;
    const request = abortableRequest(scope.signal, () =>
      this.invokeCommand<Record<string, unknown>>('get_configs')
    )
      .then(configs => {
        if (scope.signal.aborted) throw new DOMException('Request superseded', 'AbortError');
        if (this.vault.isAccessible()) this.pathService.setRemoteNames(Object.keys(configs));
        return configs;
      })
      .finally(() => {
        if (this.configRequest === request) this.configRequest = undefined;
      });
    this.configRequest = request;
    return request;
  }

  async createRemote(
    name: string,
    parameters: ConfigRecord,
    opt?: Record<string, unknown>,
    backendName?: string
  ): Promise<void> {
    await this.writeRemote(
      'create_remote',
      name,
      parameters,
      opt,
      {
        successKey: 'backendSuccess.remote.created',
        successParams: { name },
        errorKey: 'backendErrors.remote.configFailed',
      },
      backendName
    );
  }

  async updateRemote(
    name: string,
    parameters: ConfigRecord,
    opt?: Record<string, unknown>,
    backendName?: string
  ): Promise<void> {
    await this.writeRemote(
      'update_remote',
      name,
      parameters,
      opt,
      {
        successKey: 'backendSuccess.remote.updated',
        successParams: { name },
        errorKey: 'backendErrors.remote.configFailed',
      },
      backendName
    );
  }

  private async writeRemote(
    command: string,
    name: string,
    parameters: ConfigRecord,
    opt: Record<string, unknown> | undefined,
    options: WriteRemoteOptions,
    backendName?: string
  ): Promise<void> {
    await this.invokeWithNotification(
      command,
      { name, parameters, ...(opt && { opt }), ...(backendName && { backendName }) },
      {
        successKey: options.successKey,
        successParams: options.successParams,
        errorKey: options.errorKey,
      }
    );
  }

  async deleteRemote(name: string, backendName?: string): Promise<void> {
    await this.invokeCommand('delete_remote', { name, ...(backendName && { backendName }) });
  }

  /** Cancels an in-progress OAuth flow on the backend. */
  async quitOAuth(): Promise<void> {
    return this.invokeCommand('cancel_oauth');
  }

  async getLocalDrives(): Promise<LocalDrive[]> {
    return abortableRequest(this.scope.signal, () =>
      this.invokeCommand<LocalDrive[]>('get_local_drives')
    );
  }

  async startRemoteConfigInteractive(
    name: string,
    type: string,
    parameters?: Record<string, unknown>,
    opt?: Record<string, unknown>,
    backendName?: string
  ): Promise<RcConfigQuestionResponse> {
    return this.invokeCommand('create_remote_interactive', {
      name,
      rcloneType: type,
      ...(parameters !== undefined && { parameters }),
      ...(opt !== undefined && { opt }),
      ...(backendName && { backendName }),
    });
  }

  async continueRemoteConfigInteractive(
    name: string,
    stateToken: string,
    result: unknown,
    parameters?: Record<string, unknown>,
    opt?: Record<string, unknown>,
    backendName?: string
  ): Promise<RcConfigQuestionResponse> {
    return this.invokeCommand('continue_create_remote_interactive', {
      name,
      stateToken,
      result,
      ...(parameters !== undefined && { parameters }),
      ...(opt !== undefined && { opt }),
      ...(backendName && { backendName }),
    });
  }

  async obscureValue(cleartext: string): Promise<string> {
    return this.invokeCommand<string>('obscure_value', { clear: cleartext });
  }
}
