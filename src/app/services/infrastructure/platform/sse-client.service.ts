import { DestroyRef, inject, Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { RCLONE_ENGINE_STATUS_CHANGED } from '@app/types';
import { ApiClientService } from './api-client.service';

interface SseEvent {
  event: string;
  payload: unknown;
}

@Injectable({ providedIn: 'root' })
export class SseClientService {
  private readonly apiClient = inject(ApiClientService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly events$ = new Subject<SseEvent>();

  private readonly connections = new Subject<void>();
  readonly connected$ = this.connections.asObservable();

  private source: EventSource | null = null;
  private pendingConnection: Promise<void> | null = null;
  private reconnectAttempt = 0;
  private readonly maxReconnectAttempts = 50;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.disconnect();
      this.events$.complete();
      this.connections.complete();
    });
  }

  connect(): Promise<void> {
    if (this.source) return Promise.resolve();
    if (this.pendingConnection) return this.pendingConnection;
    this.disconnect();
    const pending = this.apiClient
      .invoke('auth_session', {})
      .catch(() => {
        /* The auth session request is optional. */
      })
      .then(() => {
        if (this.pendingConnection !== pending) return;
        this.pendingConnection = null;
        this.openSource(`${this.apiClient.getApiBase()}/events`);
      });
    this.pendingConnection = pending;
    return pending;
  }

  disconnect(): void {
    this.pendingConnection = null;
    this.reconnectAttempt = 0;
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

  private openSource(url: string): void {
    const source = new EventSource(url, { withCredentials: true });
    this.source = source;

    source.onopen = (): void => {
      if (this.source !== source) return;
      this.reconnectAttempt = 0;
      this.connections.next();
      this.events$.next({ event: RCLONE_ENGINE_STATUS_CHANGED, payload: { status: 'ready' } });
    };

    source.onerror = (): void => {
      if (this.source !== source) return;
      source.close();
      this.source = null;

      if (this.reconnectAttempt >= this.maxReconnectAttempts) return;

      const delay = Math.min(5000, 1000 * Math.pow(1.5, Math.min(this.reconnectAttempt++, 10)));
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.openSource(url);
      }, delay);
    };

    source.onmessage = ({ data }): void => {
      if (this.source !== source) return;
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
