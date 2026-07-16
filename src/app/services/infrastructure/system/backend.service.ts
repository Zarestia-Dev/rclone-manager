import { computed, inject, Injectable, signal, resource } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { merge } from 'rxjs';
import { TauriBaseService } from '../platform/tauri-base.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { EventListenersService } from './event-listeners.service';

import { BackendInfo, TestConnectionResult, AddBackendArgs, RuntimeStatus } from '@app/types';

@Injectable({ providedIn: 'root' })
export class BackendService extends TauriBaseService {
  readonly activeBackend = signal<string>('Local');
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly eventListenersService = inject(EventListenersService);

  // Use Angular 19+ resource API for native async loading, caching, and state management
  readonly backendData = resource({
    loader: async () => {
      const backends = await this.invokeCommand<BackendInfo[]>('list_backends');
      const active = backends.find(b => b.isActive);
      if (active) this.activeBackend.set(active.name);
      return backends;
    },
  });

  // Derived signals replacing manual state
  readonly backends = computed(() => this.backendData.value() ?? []);
  readonly isLoading = computed(() => this.backendData.isLoading());

  constructor() {
    super();
    merge(
      this.eventListenersService.listenToRcloneEngineReady(),
      this.eventListenersService.listenToBackendSwitched()
    )
      .pipe(takeUntilDestroyed())
      .subscribe(evt => {
        if (typeof evt === 'string') {
          this.activeBackend.set(evt);
        }
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

  // Legacy API support for components expecting a Promise
  async loadBackends(): Promise<void> {
    this.backendData.reload();
  }

  async runStartupChecks(): Promise<void> {
    await this.backendData.reload();
    await this.checkStartupConnectivity();
    await this.checkAllBackends();
  }

  async getActiveBackend(): Promise<string> {
    const name = await this.invokeCommand<string>('get_active_backend');
    this.activeBackend.set(name);
    return name;
  }

  async getActiveConfigPathFromBackend(): Promise<string> {
    return this.invokeCommand<string>('get_rclone_config_file');
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

  async addBackend(
    config: AddBackendArgs,
    copyBackendFrom?: string,
    copyRemotesFrom?: string
  ): Promise<void> {
    await this.invokeCommand('add_backend', {
      params: {
        name: config.name,
        host: config.host,
        port: config.port,
        isLocal: config.isLocal,
        username: config.username,
        password: config.password,
        configPassword: config.configPassword,
        configPath: config.configPath,
        oauthPort: config.oauthPort,
        oauthHost: config.oauthHost,
        copyBackendFrom: copyBackendFrom ?? null,
        copyRemotesFrom: copyRemotesFrom ?? null,
      },
    });
    this.backendData.reload();
  }

  async updateBackend(config: AddBackendArgs): Promise<void> {
    await this.invokeCommand('update_backend', {
      params: {
        name: config.name,
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        configPassword: config.configPassword,
        configPath: config.configPath,
        oauthPort: config.oauthPort,
        oauthHost: config.oauthHost,
      },
    });
    this.backendData.reload();
  }

  async removeBackend(name: string): Promise<void> {
    await this.invokeCommand('remove_backend', { name });
    // Optimistic UI update
    this.backendData.update(current => (current ?? []).filter(b => b.name !== name));
    await this.appSettingsService.removeBackendLayout(name);
  }

  async testConnection(name: string): Promise<TestConnectionResult> {
    try {
      const result = await this.invokeCommand<TestConnectionResult>('test_backend_connection', {
        name,
      });

      this.backendData.update(current =>
        (current ?? []).map(b =>
          b.name !== name
            ? b
            : {
                ...b,
                status: result.success
                  ? { type: 'connected' }
                  : { type: 'error', message: result.message },
                version: result.version,
                os: result.os,
                runtimeConfigPath: result.config_path,
              }
        )
      );

      return result;
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async testConnectionDetails(details: {
    host: string;
    port: number;
    username?: string;
    password?: string;
  }): Promise<{ success: boolean; message: string; version?: string; os?: string }> {
    try {
      return await this.invokeCommand<TestConnectionResult>('test_backend_connection_details', {
        host: details.host,
        port: details.port,
        username: details.username || null,
        password: details.password || null,
      });
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async checkStartupConnectivity(): Promise<void> {
    const activeName = await this.getActiveBackend();
    if (activeName === 'Local') return;
    try {
      await this.testConnection(activeName);
    } catch (error) {
      console.error(`Failed to check connectivity for '${activeName}':`, error);
    }
  }

  async checkAllBackends(): Promise<void> {
    await Promise.allSettled(
      this.backends()
        .filter(b => b.name !== 'Local')
        .map(b => this.testConnection(b.name))
    );
  }

  getStatusClass(status?: RuntimeStatus): string {
    if (!status) return 'disconnected';
    if (status.type === 'connected') return 'connected';
    if (status.type === 'inactive') return 'inactive';
    return 'disconnected';
  }

  updateActiveBackendStatus(
    status: RuntimeStatus,
    info?: { version?: string; os?: string; configPath?: string }
  ): void {
    const activeBackend = this.activeBackend();
    if (!activeBackend || activeBackend === 'Local') return;

    this.backendData.update(backends =>
      (backends ?? []).map(b =>
        b.name !== activeBackend
          ? b
          : {
              ...b,
              status,
              version: info?.version ?? b.version,
              os: info?.os ?? b.os,
              runtimeConfigPath: info?.configPath ?? b.runtimeConfigPath,
            }
      )
    );
  }

  mapFormToConfig(formValue: any, isLocal: boolean): AddBackendArgs {
    return {
      name: formValue.name,
      host: formValue.host,
      port: Number(formValue.port),
      isLocal,
      username: formValue.has_auth ? (formValue.username ?? '') : '',
      password: formValue.has_auth ? (formValue.password ?? '') : '',
      configPassword: formValue.config_password || undefined,
      configPath: formValue.config_path || undefined,
      oauthPort: formValue.oauth_port ? Number(formValue.oauth_port) : undefined,
      oauthHost: formValue.oauth_host || undefined,
    };
  }

  mapFormToUpdateConfig(formValue: any, editingName: string, isLocal: boolean): AddBackendArgs {
    return {
      name: editingName,
      host: formValue.host,
      port: Number(formValue.port),
      isLocal,
      username: formValue.has_auth ? formValue.username || undefined : '',
      password: formValue.has_auth ? formValue.password || undefined : '',
      configPassword: formValue.config_password || undefined,
      configPath: formValue.config_path || undefined,
      oauthPort: formValue.oauth_port ? Number(formValue.oauth_port) : undefined,
      oauthHost: formValue.oauth_host || undefined,
    };
  }
}
