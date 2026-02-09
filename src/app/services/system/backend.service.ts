import { computed, Injectable, signal } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';
import {
  AddBackendConfig,
  BackendInfo,
  TestConnectionResult,
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
    return active?.runtime_config_path ?? null;
  });

  /**
   * Load all backends from the Tauri backend
   */
  async loadBackends(): Promise<void> {
    try {
      this.isLoading.set(true);
      const backends = await this.invokeCommand<BackendInfo[]>('list_backends');
      this.backends.set(backends);

      // Update active backend name
      const active = backends.find(b => b.is_active);
      if (active) {
        this.activeBackend.set(active.name);
      }
    } catch (error) {
      console.error('[BackendService] Failed to load backends:', error);
      throw error;
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Load backends and perform startup connectivity checks in the background
   */
  runStartupChecks(): void {
    this.loadBackends()
      .then(async () => {
        await this.checkStartupConnectivity();
        await this.checkAllBackends();
      })
      .catch(error => {
        console.error('[BackendService] Failed to run startup checks:', error);
      });
  }

  /**
   * Get the currently active backend name
   */
  async getActiveBackend(): Promise<string> {
    try {
      const name = await this.invokeCommand<string>('get_active_backend');
      this.activeBackend.set(name);
      return name;
    } catch (error) {
      console.error('Failed to get active backend:', error);
      throw error;
    }
  }

  /**
   * Get the active config file path
   */
  async getActiveConfigPathFromBackend(): Promise<string> {
    try {
      return await this.invokeCommand<string>('get_rclone_config_file');
    } catch (error) {
      console.error('Failed to get active config path:', error);
      throw error;
    }
  }

  /**
   * Switch to a different backend
   * For remote backends, this also tests connection and refreshes cache
   */
  async switchBackend(name: string): Promise<void> {
    try {
      this.isLoading.set(true);
      await this.invokeCommand<void>('switch_backend', { name });
      this.activeBackend.set(name);

      // Update local state - backend switch already updates status
      this.backends.update(current =>
        current.map(b => ({
          ...b,
          is_active: b.name === name,
        }))
      );
    } catch (error) {
      console.error(`Failed to switch to backend '${name}':`, error);
      throw error;
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
      await this.invokeCommand<void>('add_backend', {
        name: config.name,
        host: config.host,
        port: config.port,
        isLocal: config.is_local,
        username: config.username,
        password: config.password,
        configPassword: config.config_password,
        configPath: config.config_path,
        oauthPort: config.oauth_port,
        copyBackendFrom: copyBackendFrom ?? null,
        copyRemotesFrom: copyRemotesFrom ?? null,
      });

      // Reload to ensure we have the exact state from backend
      await this.loadBackends();
    } catch (error) {
      console.error(`Failed to add backend '${config.name}':`, error);
      throw error;
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
      await this.invokeCommand<void>('update_backend', {
        name: config.name,
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        configPassword: config.config_password,
        configPath: config.config_path,
        oauthPort: config.oauth_port,
      });

      // Reload to ensure consistency
      await this.loadBackends();
    } catch (error) {
      console.error(`Failed to update backend '${config.name}':`, error);
      throw error;
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
      await this.invokeCommand<void>('remove_backend', { name });

      // Update local state without reloading
      this.backends.update(current => current.filter(b => b.name !== name));
    } catch (error) {
      console.error(`Failed to remove backend '${name}':`, error);
      throw error;
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
              runtime_config_path: result.config_path,
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
              runtime_config_path: info?.configPath ?? b.runtime_config_path,
            }
          : b
      )
    );
  }
}
