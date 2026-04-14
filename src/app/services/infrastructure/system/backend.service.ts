import { computed, Injectable, signal } from '@angular/core';
import { TauriBaseService } from '../platform/tauri-base.service';

import {
  BackendInfo,
  TestConnectionResult,
  BackendSettingMetadata,
  addBackendArgs,
} from 'src/app/shared/types/backend.types';

@Injectable({
  providedIn: 'root',
})
export class BackendService extends TauriBaseService {
  readonly backends = signal<BackendInfo[]>([]);
  readonly activeBackend = signal<string>('Local');
  readonly isLoading = signal<boolean>(false);

  readonly activeConfigPath = computed(() => {
    const active = this.backends().find(b => b.name === this.activeBackend());
    return active?.runtimeConfigPath ?? null;
  });

  async getBackendSchema(): Promise<Record<string, BackendSettingMetadata>> {
    return this.invokeCommand<Record<string, BackendSettingMetadata>>('get_backend_schema');
  }

  async loadBackends(): Promise<void> {
    try {
      this.isLoading.set(true);
      const backends = await this.invokeCommand<BackendInfo[]>('list_backends');
      this.backends.set(backends);
      const active = backends.find(b => b.isActive);
      if (active) this.activeBackend.set(active.name);
    } finally {
      this.isLoading.set(false);
    }
  }

  async runStartupChecks(): Promise<void> {
    await this.loadBackends();
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
    try {
      this.isLoading.set(true);
      await this.invokeWithNotification(
        'switch_backend',
        { name },
        {
          successKey: 'backendSuccess.backend.switched',
          errorKey: 'backendErrors.request.failed',
        }
      );
      this.activeBackend.set(name);
      this.backends.update(current => current.map(b => ({ ...b, isActive: b.name === name })));
    } finally {
      this.isLoading.set(false);
    }
  }

  async addBackend(
    config: addBackendArgs,
    copyBackendFrom?: string,
    copyRemotesFrom?: string
  ): Promise<void> {
    try {
      this.isLoading.set(true);
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
      await this.loadBackends();
    } finally {
      this.isLoading.set(false);
    }
  }

  async updateBackend(config: addBackendArgs): Promise<void> {
    try {
      this.isLoading.set(true);
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
      await this.loadBackends();
    } finally {
      this.isLoading.set(false);
    }
  }

  async removeBackend(name: string): Promise<void> {
    try {
      this.isLoading.set(true);
      await this.invokeCommand('remove_backend', { name });
      this.backends.update(current => current.filter(b => b.name !== name));
    } finally {
      this.isLoading.set(false);
    }
  }

  async testConnection(name: string): Promise<TestConnectionResult> {
    try {
      const result = await this.invokeCommand<TestConnectionResult>('test_backend_connection', {
        name,
      });

      this.backends.update(current =>
        current.map(b =>
          b.name !== name
            ? b
            : {
                ...b,
                status: result.success ? 'connected' : 'error',
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

  getStatusClass(status?: string): string {
    if (!status) return 'disconnected';
    if (status === 'connected') return 'connected';
    return 'disconnected';
  }

  updateActiveBackendStatus(
    status: 'connected' | 'error',
    info?: { version?: string; os?: string; configPath?: string }
  ): void {
    const activeBackend = this.activeBackend();
    if (!activeBackend || activeBackend === 'Local') return;

    this.backends.update(backends =>
      backends.map(b =>
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

  /**
   * Maps a form value to addBackendArgs for creating a new backend.
   * All fields are sent explicitly, including empty strings to clear values.
   */
  mapFormToConfig(
    formValue: {
      name: string;
      host: string;
      port: number | string;
      has_auth: boolean;
      username?: string;
      password?: string;
      config_password?: string;
      config_path?: string;
      oauth_host?: string;
      oauth_port?: number | string;
    },
    isLocal: boolean
  ): addBackendArgs {
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

  /**
   * Maps a form value to addBackendArgs for updating an existing backend.
   *
   * Key difference from `mapFormToConfig`: credentials left blank are sent as
   * `undefined` (Rust receives `None`) so the backend preserves the existing
   * stored value instead of overwriting with an empty string.
   *
   * Rules:
   *  - has_auth OFF          → send undefined (clear on the Rust side via None/None arm)
   *  - has_auth ON + filled  → send the new value
   *  - has_auth ON + blank   → send undefined (preserve existing on Rust side)
   */
  mapFormToUpdateConfig(
    formValue: {
      host: string;
      port: number | string;
      has_auth: boolean;
      username?: string;
      password?: string;
      config_password?: string;
      config_path?: string;
      oauth_host?: string;
      oauth_port?: number | string;
    },
    editingName: string,
    isLocal: boolean
  ): addBackendArgs {
    return {
      name: editingName,
      host: formValue.host,
      port: Number(formValue.port),
      isLocal,
      username: formValue.has_auth && formValue.username ? formValue.username : undefined,
      password: formValue.has_auth && formValue.password ? formValue.password : undefined,
      configPassword: formValue.config_password || undefined,
      configPath: formValue.config_path || undefined,
      oauthPort: formValue.oauth_port ? Number(formValue.oauth_port) : undefined,
      oauthHost: formValue.oauth_host || undefined,
    };
  }
}
