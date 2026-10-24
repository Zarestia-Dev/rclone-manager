import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { BackendTranslationService } from '../i18n/backend-translation.service';
import { NotificationService } from '../ui/notification.service';
import { RcloneBackendOptionsService } from './rclone-backend-options.service';

describe('RcloneBackendOptionsService persisted options', () => {
  let service: RcloneBackendOptionsService;
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invoke = vi.fn().mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        { provide: ApiClientService, useValue: { invoke } },
        { provide: BackendTranslationService, useValue: {} },
        { provide: NotificationService, useValue: {} },
      ],
    });
    service = TestBed.inject(RcloneBackendOptionsService);
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([
    { block: 'main', option: 'AskPassword', value: false },
    { block: 'main', option: 'Retries', value: 0 },
    { block: 'main', option: 'LogFile', value: '' },
    { block: 'filter', option: 'ExcludeRule', value: ['Arşiv & 旅行', 'folder/path'] },
  ])(
    'persists $block.$option without applying or coercing its value',
    async ({ block, option, value }) => {
      await service.saveOption(block, option, value);
      expect(invoke).toHaveBeenCalledExactlyOnceWith('save_rclone_backend_option', {
        block,
        option,
        value,
      });
    }
  );

  it('removes a single persisted override when resetting an option to its default', async () => {
    await service.removeOption('main', 'HTTP.ListenAddr');
    expect(invoke).toHaveBeenCalledExactlyOnceWith('remove_rclone_backend_option', {
      block: 'main',
      option: 'HTTP.ListenAddr',
    });
  });

  it('uses the full reset command when clearing all overrides', async () => {
    await service.resetOptions();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('reset_rclone_backend_options', undefined);
  });

  it.each(['save', 'remove', 'reset'])('propagates %s failures to the caller', async operation => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new Error('store unavailable');
    invoke.mockRejectedValueOnce(error);
    const request =
      operation === 'save'
        ? service.saveOption('main', 'LogLevel', 'DEBUG')
        : operation === 'remove'
          ? service.removeOption('main', 'LogLevel')
          : service.resetOptions();
    await expect(request).rejects.toBe(error);
  });
});
