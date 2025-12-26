import { Injectable, signal } from '@angular/core';
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
      console.error('Failed to load backends:', error);
      throw error;
    } finally {
      this.isLoading.set(false);
    }
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
   * Switch to a different backend
   * For remote backends, this also tests connection and refreshes cache
   */
  async switchBackend(name: string): Promise<void> {
    try {
      this.isLoading.set(true);
      await this.invokeCommand<void>('switch_backend', { name });
      this.activeBackend.set(name);

      // Update local state without reloading
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
   * Add a new backend
   */
  async addBackend(config: AddBackendConfig): Promise<void> {
    try {
      this.isLoading.set(true);
      await this.invokeCommand<void>('add_backend', {
        name: config.name,
        host: config.host,
        port: config.port,
        backendType: config.backend_type,
        username: config.username,
        password: config.password,
        configPassword: config.config_password,
      });

      // Reload to ensure we have the exact state from backend (validation, etc)
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
  async updateBackend(
    config: AddBackendConfig & { oauth_host?: string; oauth_port?: number }
  ): Promise<void> {
    try {
      this.isLoading.set(true);
      await this.invokeCommand<void>('update_backend', {
        name: config.name,
        host: config.host,
        port: config.port,
        backendType: config.backend_type,
        username: config.username,
        password: config.password,
        configPassword: config.config_password,
        oauthHost: config.oauth_host,
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
   * Get status indicator class for a backend
   */
  getStatusClass(status: string): string {
    if (status === 'connected') return 'connected';
    if (status.startsWith('error')) return 'error';
    return 'disconnected';
  }
}
