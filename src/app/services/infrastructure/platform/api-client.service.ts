import { inject, Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { invoke } from '@tauri-apps/api/core';
import { firstValueFrom } from 'rxjs';

export const isHeadlessMode = (): boolean =>
  !(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

@Injectable({ providedIn: 'root' })
export class ApiClientService {
  private readonly http = inject(HttpClient);
  private readonly apiBase = '/api';

  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    return isHeadlessMode() ? this.invokeHttp<T>(command, args) : invoke<T>(command, args ?? {});
  }

  getApiBase(): string {
    return this.apiBase;
  }

  private async invokeHttp<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    // Commands that only make sense on the desktop — handle gracefully in web mode.
    switch (command) {
      case 'set_theme':
        return {} as T;
      case 'get_system_theme':
        return (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') as T;
      case 'open_in_files':
        throw new Error('Native file manager is not available in web mode.');
      case 'auth_session':
        await firstValueFrom(
          this.http.post(`${this.apiBase}/auth/session`, {}, { withCredentials: true })
        );
        return {} as T;
    }

    try {
      const response = await firstValueFrom(
        this.http.post<{ success: boolean; data: T; error?: string }>(
          `${this.apiBase}/invoke`,
          { command, args: args ?? {} },
          { withCredentials: true }
        )
      );

      if (response.success && response.data !== undefined) return response.data;
      throw new Error(response.error ?? 'Unknown error');
    } catch (err) {
      if (err instanceof HttpErrorResponse) {
        if (err.status === 0) throw new Error('Cannot reach the API server.', { cause: err });
        if (err.status === 401) throw new Error('Authentication required.', { cause: err });
        throw new Error(err.error?.error ?? err.message, { cause: err });
      }
      throw err;
    }
  }
}
