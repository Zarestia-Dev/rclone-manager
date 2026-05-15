import { DestroyRef, inject, Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { RCLONE_ENGINE_READY } from '@app/types';
import { ApiClientService } from './api-client.service';

export interface SseEvent {
  event: string;
  payload: unknown;
}

/**
 * Server-Sent Events client for headless/web mode.
 * Replaces Tauri's event system when the app runs in a browser.
 *
 * Reconnects automatically with exponential backoff on connection loss.
 */
@Injectable({ providedIn: 'root' })
export class SseClientService {
  private readonly apiClient = inject(ApiClientService);
  private readonly events$ = new Subject<SseEvent>();

  private source: EventSource | null = null;
  private reconnectAttempt = 0;
  private readonly maxReconnectAttempts = 50;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.disconnect();
      this.events$.complete();
    });
  }

  async connect(): Promise<void> {
    if (this.source) return;
    await this.apiClient.invoke('auth_session', {});
    this.openSource(`${this.apiClient.getApiBase()}/events`);
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.source?.close();
    this.source = null;
  }

  listen<T = unknown>(eventName: string): Observable<T> {
    return this.events$.pipe(
      filter(e => e.event === eventName),
      map(e => e.payload as T)
    );
  }

  listenAll(): Observable<SseEvent> {
    return this.events$.asObservable();
  }

  private openSource(url: string): void {
    this.source = new EventSource(url, { withCredentials: true });

    this.source.onopen = (): void => {
      this.reconnectAttempt = 0;
      this.events$.next({ event: RCLONE_ENGINE_READY, payload: null });
    };

    this.source.onerror = (): void => {
      this.source?.close();
      this.source = null;

      if (this.reconnectAttempt >= this.maxReconnectAttempts) return;

      const delay = 1000 * Math.pow(2, this.reconnectAttempt);
      this.reconnectAttempt++;
      this.reconnectTimer = setTimeout(() => this.openSource(url), delay);
    };

    this.source.onmessage = (event): void => {
      const data = event.data;
      if (data === 'keep-alive') return;
      try {
        const parsed = JSON.parse(data);
        this.events$.next(
          parsed?.event && parsed.payload !== undefined
            ? parsed
            : { event: 'message', payload: parsed }
        );
      } catch {
        // Malformed SSE frame — ignore.
      }
    };
  }
}
