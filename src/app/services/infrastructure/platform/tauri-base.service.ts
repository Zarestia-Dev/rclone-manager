import { inject, Injectable } from '@angular/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow, Window } from '@tauri-apps/api/window';
import { Observable, Subject, share } from 'rxjs';
import { ApiClientService, isHeadlessMode } from './api-client.service';
import { SseClientService } from './sse-client.service';
import { NotificationService } from '../../ui/notification.service';
import { TranslateService } from '@ngx-translate/core';
import { BackendTranslationService } from '../../i18n/backend-translation.service';
import { NotifyOptions } from '@app/types';

@Injectable({ providedIn: 'root' })
export class TauriBaseService {
  protected readonly apiClient = inject(ApiClientService);
  protected readonly notificationService = inject(NotificationService);
  protected readonly translate = inject(TranslateService);
  protected readonly backendTranslation = inject(BackendTranslationService);

  private readonly sseClient = inject(SseClientService);
  protected readonly isTauri = !isHeadlessMode();

  private readonly tauriEventStreams = new Map<string, Observable<unknown>>();

  protected getCurrentTauriWindow(): Window | undefined {
    return this.isTauri ? getCurrentWindow() : undefined;
  }

  protected invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    return this.apiClient.invoke<T>(command, args);
  }

  protected listenToEvent<T>(eventName: string): Observable<T> {
    if (!this.isTauri) {
      return this.sseClient.listen<T>(eventName);
    }

    let stream = this.tauriEventStreams.get(eventName);
    if (!stream) {
      const subject = new Subject<T>();
      void listen<T>(eventName, event => subject.next(event.payload));
      stream = subject.asObservable().pipe(share()) as Observable<unknown>;
      this.tauriEventStreams.set(eventName, stream);
    }
    return stream as Observable<T>;
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
