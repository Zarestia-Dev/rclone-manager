import { inject, Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow, Window } from '@tauri-apps/api/window';
import { Observable } from 'rxjs';
import { ApiClientService } from './api-client.service';
import { SseClientService } from './sse-client.service';

const isTauriRuntime = (): boolean =>
  typeof window !== 'undefined' &&
  !!(window as unknown as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

/**
 * Base service for Tauri communication
 * Handles common patterns for invoking Tauri commands and listening to events
 */
@Injectable({
  providedIn: 'root',
})
export class TauriBaseService {
  readonly apiClient = inject(ApiClientService);
  private readonly sseClient = inject(SseClientService);
  protected readonly isTauriEnvironment = isTauriRuntime();

  /**
   * Get the current Tauri window instance
   */
  protected getCurrentTauriWindow(): any {
    if (this.isTauriEnvironment) {
      return getCurrentWindow();
    }
  }

  /**
   * Invoke a Tauri command with error handling
   */
  protected async invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    try {
      if (this.isTauriEnvironment) {
        return await invoke<T>(command, args || {});
      }

      return await this.apiClient.invoke<T>(command, args);
    } catch (error) {
      console.error(`Error invoking ${command}:`, error);
      throw error;
    }
  }

  /**
   * Listen to Tauri events with automatic cleanup
   * In headless mode, uses SSE instead of Tauri event system
   */
  protected listenToEvent<T>(eventName: string): Observable<T> {
    if (!this.isTauriEnvironment) {
      console.debug(`[Headless] Using SSE for event: ${eventName}`);
      return this.sseClient.listen<T>(eventName);
    }

    return new Observable(observer => {
      const unlisten = listen<T>(eventName, event => {
        observer.next(event.payload);
      });

      return () => {
        unlisten.then(f => f());
      };
    });
  }

  /**
   * Batch invoke multiple commands
   */
  protected async batchInvoke<T extends unknown[]>(
    commands: { command: string; args?: Record<string, unknown> }[]
  ): Promise<T> {
    const results: unknown[] = [];

    for (const { command, args } of commands) {
      results.push(await this.invokeCommand(command, args));
    }

    return results as T;
  }
}
