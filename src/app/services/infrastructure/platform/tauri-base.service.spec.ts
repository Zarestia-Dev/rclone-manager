import { TestBed } from '@angular/core/testing';
import { Injectable } from '@angular/core';
import { TauriBaseService } from './tauri-base.service';
import { ApiClientService } from './api-client.service';
import { SseClientService } from './sse-client.service';
import { NotificationService } from '../../ui/notification.service';
import { TranslateService } from '@ngx-translate/core';
import { BackendTranslationService } from '../../i18n/backend-translation.service';
import { Observable, of } from 'rxjs';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotifyOptions } from '@app/types';

@Injectable()
class TestTauriBaseService extends TauriBaseService {
  public testInvokeWithNotification<T>(
    command: string,
    args?: Record<string, unknown>,
    options?: NotifyOptions<T>
  ): Promise<T> {
    return this.invokeWithNotification<T>(command, args, options);
  }

  public testListenToEvent<T>(eventName: string): Observable<T> {
    return this.listenToEvent<T>(eventName);
  }
}

describe('TauriBaseService', () => {
  let service: TestTauriBaseService;
  let apiClientMock: { invoke: ReturnType<typeof vi.fn> };
  let notificationMock: {
    showSuccess: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
  };
  let translateMock: { instant: ReturnType<typeof vi.fn> };
  let backendTranslationMock: { translateBackendMessage: ReturnType<typeof vi.fn> };
  let sseClientMock: { listen: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    apiClientMock = { invoke: vi.fn() };
    notificationMock = { showSuccess: vi.fn(), showError: vi.fn() };
    translateMock = {
      instant: vi.fn((key: string, params?: Record<string, unknown>) => {
        if (params) {
          return `${key}:${JSON.stringify(params)}`;
        }
        return key;
      }),
    };
    backendTranslationMock = {
      translateBackendMessage: vi.fn((err: unknown) => `translated:${String(err)}`),
    };
    sseClientMock = { listen: vi.fn().mockReturnValue(of()) };

    TestBed.configureTestingModule({
      providers: [
        TestTauriBaseService,
        { provide: ApiClientService, useValue: apiClientMock },
        { provide: NotificationService, useValue: notificationMock },
        { provide: TranslateService, useValue: translateMock },
        { provide: BackendTranslationService, useValue: backendTranslationMock },
        { provide: SseClientService, useValue: sseClientMock },
      ],
    });

    service = TestBed.inject(TestTauriBaseService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('invokeWithNotification', () => {
    it('returns command result without showing notification if no successKey is provided', async () => {
      apiClientMock.invoke.mockResolvedValueOnce({ status: 'ok' });

      const res = await service.testInvokeWithNotification('test_cmd', { foo: 'bar' });

      expect(res).toEqual({ status: 'ok' });
      expect(apiClientMock.invoke).toHaveBeenCalledWith('test_cmd', { foo: 'bar' });
      expect(notificationMock.showSuccess).not.toHaveBeenCalled();
    });

    it('shows success notification with static successParams', async () => {
      apiClientMock.invoke.mockResolvedValueOnce('success_data');

      await service.testInvokeWithNotification('test_cmd', undefined, {
        successKey: 'common.success',
        successParams: { id: '123' },
      });

      expect(notificationMock.showSuccess).toHaveBeenCalledWith('common.success:{"id":"123"}');
    });

    it('shows success notification with functional successParams based on result', async () => {
      apiClientMock.invoke.mockResolvedValueOnce({ addr: '127.0.0.1:8080' });

      await service.testInvokeWithNotification<{ addr: string }>('test_cmd', undefined, {
        successKey: 'serve.successStart',
        successParams: res => ({ host: res.addr }),
      });

      expect(notificationMock.showSuccess).toHaveBeenCalledWith(
        'serve.successStart:{"host":"127.0.0.1:8080"}'
      );
    });

    it('shows translated error and re-throws when invoke fails without errorKey', async () => {
      const err = new Error('RPC failure');
      apiClientMock.invoke.mockRejectedValueOnce(err);

      await expect(service.testInvokeWithNotification('test_cmd')).rejects.toThrow('RPC failure');

      expect(backendTranslationMock.translateBackendMessage).toHaveBeenCalledWith(err);
      expect(notificationMock.showError).toHaveBeenCalledWith('translated:Error: RPC failure');
    });

    it('shows wrapped error with errorKey and re-throws when invoke fails', async () => {
      const err = new Error('RPC failure');
      apiClientMock.invoke.mockRejectedValueOnce(err);

      await expect(
        service.testInvokeWithNotification('test_cmd', undefined, {
          errorKey: 'serve.failedStop',
          errorParams: { id: 'http-1' },
        })
      ).rejects.toThrow('RPC failure');

      expect(translateMock.instant).toHaveBeenCalledWith('serve.failedStop', {
        id: 'http-1',
        error: 'translated:Error: RPC failure',
      });
      expect(notificationMock.showError).toHaveBeenCalledWith(
        'serve.failedStop:{"id":"http-1","error":"translated:Error: RPC failure"}'
      );
    });
  });
});
