import { DestroyRef, inject, Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { RCLONE_ENGINE_STATUS_CHANGED } from '@app/types';
import { ApiClientService } from './api-client.service';

export interface SseEvent {
  event: string;
  payload: unknown;
}

@Injectable({ providedIn: 'root' })
export class SseClientService {
  private readonly apiClient = inject(ApiClientService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly events$ = new Subject<SseEvent>();

  private source: EventSource | null = null;
  private reconnectAttempt = 0;
  private readonly maxReconnectAttempts = 50;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.disconnect();
      this.events$.complete();
    });
  }

  async connect(): Promise<void> {
    if (this.source) return;
    try {
      await this.apiClient.invoke('auth_session', {});
    } catch {
      console.log('Auth session failed');
    }
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
      this.events$.next({ event: RCLONE_ENGINE_STATUS_CHANGED, payload: { status: 'ready' } });
    };

    this.source.onerror = (): void => {
      this.source?.close();
      this.source = null;

      if (this.reconnectAttempt >= this.maxReconnectAttempts) return;

      const delay = 1000 * Math.pow(2, this.reconnectAttempt++);
      this.reconnectTimer = setTimeout(() => this.openSource(url), delay);
    };

    this.source.onmessage = ({ data }): void => {
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
