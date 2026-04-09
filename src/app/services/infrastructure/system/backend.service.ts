import { computed, Injectable, signal } from '@angular/core';
import { TauriBaseService } from '../platform/tauri-base.service';

import {
  AddBackendConfig,
  BackendInfo,
  TestConnectionResult,
  BackendSettingMetadata,
} from 'src/app/shared/types/backend.types';

/**
 * Service for managing rclone backends (local and remote)
 * Communicates with Tauri backend commands for CRUD operations
 */
@Injectable({
  providedIn: 'root',
})
export class BackendService extends TauriBaseService {
  /** All available backends */
  readonly backends = signal<BackendInfo[]>([]);

  /** Name of the currently active backend */
  readonly activeBackend = signal<string>('Local');

  /** Whether backend operations are in progress */
  readonly isLoading = signal<boolean>(false);

  /** Active config path from the currently active backend's runtime info */
  readonly activeConfigPath = computed(() => {
    const backends = this.backends();
    const activeName = this.activeBackend();
    const active = backends.find(b => b.name === activeName);
    return active?.runtimeConfigPath ?? null;
  });

  /**
   * Get the backend settings schema for UI generation
   */
  async getBackendSchema(): Promise<Record<string, BackendSettingMetadata>> {
    return await this.invokeCommand<Record<string, BackendSettingMetadata>>('get_backend_schema');
  }

  /**
   * Load all backends from the Tauri backend
   */
  async loadBackends(): Promise<void> {
    try {
      this.isLoading.set(true);
      const backends = await this.invokeCommand<BackendInfo[]>('list_backends');
      this.backends.set(backends);

      // Update active backend name
      const active = backends.find(b => b.isActive);
      if (active) {
        this.activeBackend.set(active.name);
      }
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Load backends and perform startup connectivity checks in the background
   */
  async runStartupChecks(): Promise<void> {
    await this.loadBackends();
    await this.checkStartupConnectivity();
    await this.checkAllBackends();
  }

  /**
   * Get the currently active backend name
   */
  async getActiveBackend(): Promise<string> {
    const name = await this.invokeCommand<string>('get_active_backend');
    this.activeBackend.set(name);
    return name;
  }

  /**
   * Get the active config file path
   */
  async getActiveConfigPathFromBackend(): Promise<string> {
    return await this.invokeCommand<string>('get_rclone_config_file');
  }

  /**
   * Switch to a different backend
   * For remote backends, this also tests connection and refreshes cache
   */
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

      // Update local state - backend switch already updates status
      this.backends.update(current =>
        current.map(b => ({
          ...b,
          isActive: b.name === name,
        }))
      );
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Add a new backend with optional copying from existing backends
   */
  async addBackend(
    config: AddBackendConfig,
    copyBackendFrom?: string,
    copyRemotesFrom?: string
  ): Promise<void> {
    try {
      this.isLoading.set(true);
      await this.invokeWithNotification(
        'add_backend',
        {
          name: config.name,
          host: config.host,
          port: config.port,
          isLocal: config.isLocal,
          username: config.username,
          password: config.password,
          configPassword: config.configPassword,
          configPath: config.configPath,
          oauthPort: config.oauthPort,
          copyBackendFrom: copyBackendFrom ?? null,
          copyRemotesFrom: copyRemotesFrom ?? null,
        },
        {
          successKey: 'backendSuccess.backend.added',
          errorKey: 'backendErrors.request.failed',
        }
      );

      // Reload to ensure we have the exact state from backend
      await this.loadBackends();
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Update an existing backend
   */
  async updateBackend(config: AddBackendConfig): Promise<void> {
    try {
      this.isLoading.set(true);
      await this.invokeWithNotification(
        'update_backend',
        {
          name: config.name,
          host: config.host,
          port: config.port,
          username: config.username,
          password: config.password,
          configPassword: config.configPassword,
          configPath: config.configPath,
          oauthPort: config.oauthPort,
        },
        {
          successKey: 'backendSuccess.backend.updated',
          errorKey: 'backendErrors.request.failed',
        }
      );

      // Reload to ensure consistency
      await this.loadBackends();
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Remove a backend
   */
  async removeBackend(name: string): Promise<void> {
    try {
      this.isLoading.set(true);
      await this.invokeWithNotification(
        'remove_backend',
        { name },
        {
          successKey: 'backendSuccess.backend.removed',
          errorKey: 'backendErrors.request.failed',
        }
      );

      // Update local state without reloading
      this.backends.update(current => current.filter(b => b.name !== name));
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Test connection to a specific backend
   */
  async testConnection(name: string): Promise<TestConnectionResult> {
    try {
      const result = await this.invokeCommand<TestConnectionResult>('test_backend_connection', {
        name,
      });

      // Update local status without reloading
      this.backends.update(current =>
        current.map(b => {
          if (b.name === name) {
            return {
              ...b,
              status: result.success ? 'connected' : 'error',
              version: result.version,
              os: result.os,
              runtimeConfigPath: result.config_path,
            };
          }
          return b;
        })
      );

      return result;
    } catch (error) {
      console.error(`Failed to test connection to '${name}':`, error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Check startup connectivity and sync with backend state
   */
  async checkStartupConnectivity(): Promise<void> {
    const activeName = await this.getActiveBackend();
    if (activeName === 'Local') return;

    // Await the test to ensure we have the result before returning
    try {
      await this.testConnection(activeName);
    } catch (error) {
      console.error(`Failed to check connectivity for '${activeName}':`, error);
    }
  }

  /**
   * Check all backends connectivity in background
   */
  async checkAllBackends(): Promise<void> {
    const backends = this.backends();
    const promises = backends.filter(b => b.name !== 'Local').map(b => this.testConnection(b.name));

    await Promise.allSettled(promises);
  }

  /**
   * Get status indicator class for a backend
   */
  getStatusClass(status?: string): string {
    if (!status) return 'disconnected';
    if (status === 'connected') return 'connected';
    return 'disconnected';
  }

  /**
   * Update the currently active backend status without reloading
   */
  updateActiveBackendStatus(
    status: 'connected' | 'error',
    info?: { version?: string; os?: string; configPath?: string }
  ): void {
    const activeBackend = this.activeBackend();
    if (!activeBackend || activeBackend === 'Local') return;

    this.backends.update(backends =>
      backends.map(b =>
        b.name === activeBackend
          ? {
              ...b,
              status,
              version: info?.version ?? b.version,
              os: info?.os ?? b.os,
              runtimeConfigPath: info?.configPath ?? b.runtimeConfigPath,
            }
          : b
      )
    );
  }
  /**
   * Helper to map form values to AddBackendConfig
   */
  mapFormToConfig(formValue: any, isEditingLocal: boolean): AddBackendConfig {
    return {
      name: formValue.name,
      host: formValue.host,
      port: Number(formValue.port),
      isLocal: isEditingLocal,
      // Send empty strings to signal "clear auth" when toggle is off
      username: formValue.has_auth ? formValue.username : '',
      password: formValue.has_auth ? formValue.password : '',
      configPassword: formValue.config_password || undefined,
      configPath: formValue.config_path || undefined,
      // OAuth port only for Local backend
      oauthPort: isEditingLocal ? Number(formValue.oauth_port) : undefined,
    };
  }
}
