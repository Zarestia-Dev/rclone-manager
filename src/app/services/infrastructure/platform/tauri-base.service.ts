import { inject, Injectable } from '@angular/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow, Window } from '@tauri-apps/api/window';
import { Observable } from 'rxjs';
import { ApiClientService, isHeadlessMode } from './api-client.service';
import { SseClientService } from './sse-client.service';
import { NotificationService } from '../../ui/notification.service';
import { TranslateService } from '@ngx-translate/core';
import { BackendTranslationService } from '../../i18n/backend-translation.service';
import { NotifyOptions } from '@app/types';

/**
 * Base class for services that communicate with the Tauri backend.
 * Abstracts the difference between Tauri IPC events (desktop) and SSE (web).
 */
@Injectable({ providedIn: 'root' })
export class TauriBaseService {
  protected readonly apiClient = inject(ApiClientService);
  protected readonly notificationService = inject(NotificationService);
  protected readonly translate = inject(TranslateService);
  protected readonly backendTranslation = inject(BackendTranslationService);

  private readonly sseClient = inject(SseClientService);
  protected readonly isTauri = !isHeadlessMode();

  protected getCurrentTauriWindow(): Window | undefined {
    return this.isTauri ? getCurrentWindow() : undefined;
  }

  protected async invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    return this.apiClient.invoke<T>(command, args);
  }

  protected listenToEvent<T>(eventName: string): Observable<T> {
    if (!this.isTauri) {
      return this.sseClient.listen<T>(eventName);
    }

    return new Observable(observer => {
      const unlisten = listen<T>(eventName, event => observer.next(event.payload));
      return () => {
        unlisten.then(f => f());
      };
    });
  }

  protected async batchInvoke<T extends unknown[]>(
    commands: { command: string; args?: Record<string, unknown> }[],
    parallel = false
  ): Promise<T> {
    if (parallel) {
      return Promise.all(commands.map(c => this.invokeCommand(c.command, c.args))) as Promise<T>;
    }

    const results: unknown[] = [];
    for (const { command, args } of commands) {
      results.push(await this.invokeCommand(command, args));
    }
    return results as T;
  }

  protected async invokeWithNotification<T>(
    command: string,
    args?: Record<string, unknown>,
    options?: NotifyOptions
  ): Promise<T> {
    try {
      const result = await this.invokeCommand<T>(command, args);

      if (options?.showSuccess !== false && options?.successKey) {
        this.notificationService.showSuccess(
          this.translate.instant(options.successKey, options.successParams)
        );
      }

      return result;
    } catch (error) {
      if (options?.showError !== false) {
        const errorKey = options?.errorKey ?? 'common.error';
        const translatedError = this.backendTranslation.translateBackendMessage(error);
        this.notificationService.showError(
          this.translate.instant(errorKey, { ...options?.errorParams, error: translatedError })
        );
      }
      throw error;
    }
  }
}
