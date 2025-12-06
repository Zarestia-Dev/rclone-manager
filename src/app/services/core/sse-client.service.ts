import { Injectable, OnDestroy } from '@angular/core';
import { Observable, Subject } from 'rxjs';

export interface SseEvent {
  event: string;
  payload: unknown;
}

/**
 * Server-Sent Events (SSE) client for headless mode
 * Replaces Tauri event listeners when running in web mode
 */
@Injectable({
  providedIn: 'root',
})
export class SseClientService implements OnDestroy {
  private eventSource: EventSource | null = null;
  private eventSubject = new Subject<SseEvent>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000; // Start with 1 second

  /**
   * Connect to the SSE endpoint
   */
  connect(url?: string): void {
    if (this.eventSource) {
      console.warn('SSE already connected');
      return;
    }

    // If no URL provided, determine dynamically based on current page
    if (!url) {
      const protocol = window.location.protocol; // http: or https:
      const host = window.location.hostname; // localhost, 127.0.0.1, or actual hostname
      const port = window.location.port; // 8080, 3000, etc.

      // In development mode (Angular dev server on port 1420), use the API server on port 8080
      const devApiPort = (window as Window & { RCLONE_MANAGER_API_PORT?: string })
        .RCLONE_MANAGER_API_PORT;
      let portSuffix: string;
      if (port === '1420' || devApiPort) {
        const apiPort = devApiPort || '8080';
        portSuffix = `:${apiPort}`;
        console.log('🔧 Development mode - SSE connecting to API server on port', apiPort);
      } else {
        portSuffix = port ? `:${port}` : ''; // Only add port if it's not default
      }
      url = `${protocol}//${host}${portSuffix}/api/events`;
    }

    this.createEventSource(url);
  }

  /**
   * Disconnect from SSE
   */
  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
      console.log('🔌 SSE disconnected');
    }
  }

  /**
   * Listen to a specific event
   */
  listen<T = unknown>(eventName: string): Observable<T> {
    return new Observable(observer => {
      const subscription = this.eventSubject.subscribe(event => {
        if (event.event === eventName) {
          observer.next(event.payload as T);
        }
      });

      return () => subscription.unsubscribe();
    });
  }

  /**
   * Listen to all events
   */
  listenAll(): Observable<SseEvent> {
    return this.eventSubject.asObservable();
  }

  private createEventSource(url: string): void {
    console.log('🔌 Connecting to SSE:', url);
    // Browser handles Basic Auth automatically for EventSource
    this.eventSource = new EventSource(url, { withCredentials: true });

    this.eventSource.onopen = (): void => {
      console.log('✅ SSE connected');
      this.reconnectAttempts = 0;
      this.reconnectDelay = 1000;
    };

    this.eventSource.onerror = (error): void => {
      console.error('❌ SSE connection error:', error);
      this.eventSource?.close();
      this.eventSource = null;

      // Attempt to reconnect with exponential backoff
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
        console.log(`🔄 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);

        setTimeout(() => {
          this.createEventSource(url);
        }, delay);
      } else {
        console.error('❌ Max reconnection attempts reached. Giving up.');
      }
    };

    // Handle all incoming messages with a generic handler
    this.eventSource.onmessage = (event): void => {
      console.debug('🔔 SSE onmessage received:', event.data);
      if (event.data === 'keep-alive') {
        return; // Ignore keep-alive messages
      }

      try {
        const data = JSON.parse(event.data);
        // The backend sends { event: string, payload: any }
        if (data.event && data.payload !== undefined) {
          console.debug('🔔 SSE parsed event:', data.event);
          this.eventSubject.next({
            event: data.event,
            payload: data.payload,
          });
        } else {
          // Fallback for simple messages
          this.eventSubject.next({
            event: event.type || 'message',
            payload: data,
          });
        }
      } catch (error) {
        console.error('Failed to parse SSE message:', error);
      }
    };
  }

  ngOnDestroy(): void {
    this.disconnect();
    this.eventSubject.complete();
  }
}
