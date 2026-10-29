import { computed, inject, Injectable, signal, resource } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { filter, firstValueFrom, merge } from 'rxjs';
import { TauriBaseService } from '../platform/tauri-base.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { EventListenersService } from './event-listeners.service';

import { BackendInfo, TestConnectionResult, AddBackendArgs, RuntimeStatus } from '@app/types';

const LOCAL_BACKEND_NAME = 'Local';

interface BackendFormValues {
  name: string;
  host: string;
  port: string | number;
  has_auth: boolean;
  username?: string;
  password?: string;
  config_password?: string;
  config_path?: string;
}

@Injectable({ providedIn: 'root' })
export class BackendService extends TauriBaseService {
  readonly activeBackend = signal<string>('Local');
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly eventListenersService = inject(EventListenersService);

  // Use Angular 19+ resource API for native async loading, caching, and state management
  readonly backendData = resource({
    loader: async () => {
      const backends = (await this.invokeCommand<BackendInfo[]>('list_backends')) || [];
      const active = backends.find(b => b.isActive);
      if (active) this.activeBackend.set(active.name);
      return backends;
    },
  });

  // Derived signals replacing manual state
  readonly backends = computed(() => this.backendData.value() ?? []);
  readonly isLoading = this.backendData.isLoading;
  private readonly backendLoading$ = toObservable(this.isLoading);

  constructor() {
    super();
    merge(
      this.eventListenersService.listenToRcloneEngineReady(),
      this.eventListenersService.listenToBackendSwitched()
    )
      .pipe(takeUntilDestroyed())
      .subscribe(evt => {
        if (typeof evt === 'string') this.activeBackend.set(evt);
        this.backendData.reload();
      });

    this.eventListenersService
      .listenToSettingsCategory('connections')
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        this.backendData.reload();
      });
  }

  readonly activeConfigPath = computed(() => {
    const active = this.backends().find(b => b.name === this.activeBackend());
    return active?.runtimeConfigPath ?? null;
  });

  readonly isLocalBackend = computed(() => {
    const active = this.backends().find(b => b.name === this.activeBackend());
    return active?.isLocal ?? true;
  });

  readonly isWindows = computed(() => {
    const active = this.backends().find(b => b.name === this.activeBackend());
    return active?.os?.toLowerCase().includes('windows') ?? false;
  });

  async loadBackends(): Promise<void> {
    this.backendData.reload();
    // Check current state so a replayed completion cannot finish a new reload early.
    await firstValueFrom(this.backendLoading$.pipe(filter(() => !this.isLoading())));
    const error = this.backendData.error();
    if (error) throw error;
  }

  /** Probes every remote backend; each card updates as its result arrives. */
  async refreshStatuses(): Promise<void> {
    await Promise.all(
      this.backends()
        .filter(b => !b.isLocal)
        .map(b => this.testConnection(b.name))
    );
  }

  private patchBackend(name: string, patch: Partial<BackendInfo>): void {
    this.backendData.update(current =>
      (current ?? []).map(b => (b.name === name ? { ...b, ...patch } : b))
    );
  }

  async switchBackend(name: string): Promise<void> {
    await this.invokeWithNotification(
      'switch_backend',
      { name },
      {
        successKey: 'backendSuccess.backend.switched',
        successParams: { name },
        errorKey: 'backendErrors.request.failed',
      }
    );
    this.activeBackend.set(name);
    // Optimistic UI update
    this.backendData.update(current =>
      (current ?? []).map(b => ({ ...b, isActive: b.name === name }))
    );
  }

  async addBackend(config: AddBackendArgs): Promise<void> {
    await this.saveBackend('add_backend', config);
  }

  async updateBackend(config: AddBackendArgs): Promise<void> {
    await this.saveBackend('update_backend', config);
  }

  /** Saves, reloads, then probes a remote so its card shows real status and metadata. */
  private async saveBackend(
    command: 'add_backend' | 'update_backend',
    config: AddBackendArgs
  ): Promise<void> {
    await this.invokeCommand(command, { params: config });
    await this.loadBackends();
    if (!config.isLocal) void this.testConnection(config.name);
  }

  async removeBackend(name: string): Promise<void> {
    await this.invokeCommand('remove_backend', { name });
    // Optimistic UI update
    this.backendData.update(current => (current ?? []).filter(b => b.name !== name));
    await this.appSettingsService.removeBackendLayout(name);
  }

  updateLocalBackendConfigPath(configPath: string | undefined): Promise<void> {
    return this.updateLocalBackend(() => ({ configPath: configPath || undefined }));
  }

  updateLocalBackendPort(port: number): Promise<void> {
    return this.updateLocalBackend(local => ({ port, configPath: local.configPath }));
  }

  /** Sends no credentials, so the stored ones (or the generated login) stay as they are. */
  private async updateLocalBackend(
    change: (local: BackendInfo) => Partial<AddBackendArgs>
  ): Promise<void> {
    const find = (): BackendInfo | undefined =>
      this.backends().find(b => b.name === LOCAL_BACKEND_NAME);
    if (!find()) await this.loadBackends();
    const local = find();
    if (!local) return;
    await this.updateBackend({
      name: LOCAL_BACKEND_NAME,
      host: local.host,
      port: local.port,
      isLocal: true,
      ...change(local),
    });
  }

  async testConnection(name: string): Promise<TestConnectionResult> {
    const result = await this.probe('test_backend_connection', { name });
    this.patchBackend(
      name,
      result.success
        ? {
            status: { type: 'connected' },
            version: result.version,
            os: result.os,
            runtimeConfigPath: result.config_path,
          }
        : // The backend keeps the last known version and OS next to the error.
          { status: { type: 'error', message: result.message ?? '' } }
    );
    return result;
  }

  /** `name` is the backend being edited: its stored password stands in for an empty one. */
  testConnectionDetails(details: {
    host: string;
    port: number;
    username?: string;
    password?: string;
    name?: string;
  }): Promise<TestConnectionResult> {
    return this.probe('test_backend_connection_details', {
      host: details.host,
      port: details.port,
      username: details.username || null,
      password: details.password || null,
      name: details.name ?? null,
    });
  }

  /** Runs a connection test; failures come back as a result with a ready-to-show message. */
  private async probe(
    command: string,
    args: Record<string, unknown>
  ): Promise<TestConnectionResult> {
    try {
      const result = await this.invokeCommand<TestConnectionResult>(command, args);
      return result.success
        ? result
        : { ...result, message: this.backendTranslation.translateBackendMessage(result.message) };
    } catch (error) {
      return { success: false, message: this.backendTranslation.translateBackendMessage(error) };
    }
  }

  updateActiveBackendStatus(
    status: RuntimeStatus,
    info?: { version?: string; os?: string; configPath?: string }
  ): void {
    const activeBackend = this.activeBackend();
    if (!activeBackend || activeBackend === LOCAL_BACKEND_NAME) return;

    const current = this.backends().find(b => b.name === activeBackend);
    this.patchBackend(activeBackend, {
      status,
      version: info?.version ?? current?.version,
      os: info?.os ?? current?.os,
      runtimeConfigPath: info?.configPath ?? current?.runtimeConfigPath,
    });
  }

  /**
   * `editingName` marks an update: an empty password then means "keep the stored one",
   * and the backend's name cannot change.
   */
  mapFormToConfig(
    formValue: BackendFormValues,
    isLocal: boolean,
    editingName?: string
  ): AddBackendArgs {
    return {
      name: editingName ?? formValue.name,
      host: formValue.host,
      port: Number(formValue.port),
      isLocal,
      username: formValue.has_auth ? formValue.username || undefined : '',
      password: formValue.has_auth ? formValue.password || undefined : '',
      configPassword: formValue.config_password || undefined,
      configPath: formValue.config_path || undefined,
    };
  }
}
