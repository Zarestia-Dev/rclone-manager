import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { invoke } from '@tauri-apps/api/core';
import { firstValueFrom } from 'rxjs';
import { EXPLICIT_ENDPOINTS, POST_COMMANDS } from 'src/app/shared/types/api-endpoints';

/**
 * Environment detection and API communication service
 * Automatically detects whether running in Tauri (desktop) or headless (web) mode
 * and routes API calls accordingly
 */
@Injectable({
  providedIn: 'root',
})
export class ApiClientService {
  private http = inject(HttpClient);
  private isHeadlessMode: boolean;
  private apiBaseUrl = 'http://localhost:8080/api';

  constructor() {
    this.isHeadlessMode = !(window as Window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__;

    const protocol = window.location.protocol;
    const host = window.location.hostname;
    const port = window.location.port;
    const portSuffix = port ? `:${port}` : '';

    const devApiPort = (window as Window & { RCLONE_MANAGER_API_PORT?: string })
      .RCLONE_MANAGER_API_PORT;
    if (this.isHeadlessMode && (port === '1420' || devApiPort)) {
      const apiPort = devApiPort || '8080';
      this.apiBaseUrl = `${protocol}//${host}:${apiPort}/api`;
      console.debug('🔧 Development mode detected - Angular dev server pointing to API server');
    } else {
      this.apiBaseUrl = `${protocol}//${host}${portSuffix}/api`;
    }

    if (this.isHeadlessMode) {
      console.debug('🌐 Running in headless web mode - using HTTP API');
      console.debug(`📝 API Base URL: ${this.apiBaseUrl}`);
      console.debug('🔐 Browser will handle Basic Authentication via login dialog');
    } else {
      console.debug('🖥️  Running in Tauri desktop mode - using Tauri commands');
    }
  }

  /**
   * Invoke a command - automatically routes to Tauri or HTTP API
   */
  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (this.isHeadlessMode) {
      return this.invokeHttp<T>(command, args);
    } else {
      return invoke<T>(command, args || {});
    }
  }

  /**
   * Converts an arguments object to a string-based record for HttpParams.
   */
  private toHttpParams(args: Record<string, unknown>): HttpParams {
    let params = new HttpParams();
    Object.entries(args).forEach(([key, value]) => {
      if (value !== null && value !== undefined) {
        if (Array.isArray(value)) {
          value.forEach(item => {
            params = params.append(key, String(item));
          });
        } else {
          params = params.set(key, String(value));
        }
      }
    });
    return params;
  }

  /**
   * HTTP API invocation for headless mode
   */
  private async invokeHttp<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    // Handle commands locally in web mode
    if (command === 'set_theme') {
      console.debug('🎨 Theme setting handled locally in web mode');
      return Promise.resolve({} as T);
    }

    if (command === 'get_system_theme') {
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const theme = isDark ? 'dark' : 'light';
      console.debug('🌙 System theme detected from browser:', theme);
      return Promise.resolve(theme as T);
    }

    if (command === 'open_in_files') {
      throw new Error('Native file manager integration not available in headless mode.');
    }

    const endpoint = this.mapCommandToEndpoint(command);
    const isPostCommand = POST_COMMANDS.has(command);

    try {
      const httpOptions: { params?: HttpParams; headers?: Record<string, string> } = {};

      if (!isPostCommand && args) {
        httpOptions.params = this.toHttpParams(args);
      }

      httpOptions.headers = { ...httpOptions.headers };

      const response = await firstValueFrom(
        isPostCommand
          ? this.http.post<{ success: boolean; data: T; error?: string }>(
              `${this.apiBaseUrl}${endpoint}`,
              args || {},
              { ...httpOptions, withCredentials: true }
            )
          : this.http.get<{ success: boolean; data: T; error?: string }>(
              `${this.apiBaseUrl}${endpoint}`,
              { ...httpOptions, withCredentials: true }
            )
      );

      if (response.success && response.data !== undefined) {
        return response.data;
      } else {
        throw new Error(response.error || 'Unknown error');
      }
    } catch (error: unknown) {
      if (error instanceof HttpErrorResponse) {
        if (error.error?.error) {
          throw new Error(error.error.error);
        }
        if (error.status === 0) {
          throw new Error('API server is unreachable. Is the headless server running?');
        }
        if (error.status === 401) {
          throw new Error('Authentication required. Please enter your credentials.');
        }
        throw new Error(error.message);
      }
      throw error;
    }
  }

  /**
   * Map Tauri command names to HTTP API endpoints.
   * Checks explicit mappings first, then auto-derives for standard pattern.
   */
  private mapCommandToEndpoint(command: string): string {
    // Check explicit mappings for non-standard routes
    const explicit = EXPLICIT_ENDPOINTS[command];
    if (explicit) {
      return explicit;
    }

    // Auto-derive: command_name -> /command-name
    return `/${command.replace(/_/g, '-')}`;
  }

  isHeadless(): boolean {
    return this.isHeadlessMode;
  }

  getApiBaseUrl(): string {
    return this.apiBaseUrl;
  }

  setApiBaseUrl(url: string): void {
    this.apiBaseUrl = url;
  }
}
