import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Observable } from 'rxjs';

/**
 * Base service for Tauri communication
 * Handles common patterns for invoking Tauri commands and listening to events
 */
@Injectable({
  providedIn: 'root',
})
export class TauriBaseService {
  /**
   * Invoke a Tauri command with error handling
   */
  protected async invokeCommand<T>(command: string, args?: Record<string, any>): Promise<T> {
    try {
      return await invoke<T>(command, args || {});
    } catch (error) {
      console.error(`Error invoking ${command}:`, error);
      throw error;
    }
  }

  /**
   * Listen to Tauri events with automatic cleanup
   */
  protected listenToEvent<T>(eventName: string): Observable<T> {
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
  protected async batchInvoke<T>(
    commands: { command: string; args?: Record<string, any> }[]
  ): Promise<T[]> {
    const promises = commands.map(({ command, args }) => this.invokeCommand<T>(command, args));
    return Promise.all(promises);
  }
}
