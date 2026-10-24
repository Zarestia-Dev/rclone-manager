import { inject, Injectable } from '@angular/core';
import { getCurrentWindow, Window } from '@tauri-apps/api/window';
import { ApiClientService, isHeadlessMode } from './api-client.service';
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

  protected readonly isTauri = !isHeadlessMode();

  protected getCurrentTauriWindow(): Window | undefined {
    return this.isTauri ? getCurrentWindow() : undefined;
  }

  protected invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    return this.apiClient.invoke<T>(command, args);
  }

  protected async invokeWithNotification<T>(
    command: string,
    args?: Record<string, unknown>,
    options?: NotifyOptions<T>
  ): Promise<T> {
    try {
      const result = await this.invokeCommand<T>(command, args);

      if (options?.successKey) {
        const params =
          typeof options.successParams === 'function'
            ? options.successParams(result)
            : options.successParams;
        this.notificationService.showSuccess(this.translate.instant(options.successKey, params));
      }

      return result;
    } catch (error) {
      const translatedError = this.backendTranslation.translateBackendMessage(error);
      const message = options?.errorKey
        ? this.translate.instant(options.errorKey, {
            ...options?.errorParams,
            error: translatedError,
          })
        : translatedError;
      this.notificationService.showError(message);
      throw error;
    }
  }
}
