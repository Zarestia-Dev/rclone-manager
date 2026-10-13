import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { ConnectionService } from './connection.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { ApiClientService } from '../platform/api-client.service';
import { CheckResult } from '@app/types';

describe('ConnectionService', () => {
  let service: ConnectionService;
  let mockAppSettingsService: { getSettingValue: ReturnType<typeof vi.fn> };
  let mockApiClient: { invoke: ReturnType<typeof vi.fn> };
  let translateService: TranslateService;

  beforeEach(() => {
    mockAppSettingsService = {
      getSettingValue: vi.fn().mockResolvedValue(['https://www.google.com']),
    };
    mockApiClient = {
      invoke: vi.fn().mockResolvedValue({
        successful: ['https://www.google.com'],
        failed: {},
        retries_used: {},
      }),
    };

    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        ConnectionService,
        { provide: AppSettingsService, useValue: mockAppSettingsService },
        { provide: ApiClientService, useValue: mockApiClient },
      ],
    });

    service = TestBed.inject(ConnectionService);
    translateService = TestBed.inject(TranslateService);
    translateService.setTranslation('en', {
      titlebar: {
        connection: {
          checking: 'Checking connection...',
          online: 'Connection online',
          offline: 'Connection failed: {{services}}',
        },
      },
    });
    translateService.use('en');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should initialize with online status and empty history', () => {
    expect(service.status()).toBe('online');
    expect(service.history()).toEqual([]);
    expect(service.result()).toBeUndefined();
  });

  it('should skip runInternetCheck on mobile devices', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36'
    );

    await service.runInternetCheck();

    expect(mockAppSettingsService.getSettingValue).not.toHaveBeenCalled();
    expect(mockApiClient.invoke).not.toHaveBeenCalled();
    expect(service.status()).toBe('online');
  });

  it('should perform internet check on non-mobile devices and set online status when successful', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
    );

    const checkResult: CheckResult = {
      successful: ['https://www.google.com'],
      failed: {},
      retries_used: { 'https://www.google.com': 0 },
    };
    mockApiClient.invoke.mockResolvedValue(checkResult);

    await service.runInternetCheck();

    expect(mockAppSettingsService.getSettingValue).toHaveBeenCalledWith(
      'core.connection_check_urls'
    );
    expect(mockApiClient.invoke).toHaveBeenCalledWith('check_links', {
      links: ['https://www.google.com'],
      maxRetries: 2,
      retryDelaySecs: 3,
    });
    expect(service.status()).toBe('online');
    expect(service.result()).toEqual(checkResult);
    expect(service.history().length).toBe(1);
    expect(service.history()[0].result).toEqual(checkResult);
  });

  it('should set offline status when any URL fails', async () => {
    const checkResult: CheckResult = {
      successful: [],
      failed: { 'https://www.dropbox.com': 'HTTP 500' },
      retries_used: { 'https://www.dropbox.com': 2 },
    };
    mockApiClient.invoke.mockResolvedValue(checkResult);

    await service.runInternetCheck();

    expect(service.status()).toBe('offline');
    expect(service.result()).toEqual(checkResult);
  });

  it('should handle errors gracefully and set offline status', async () => {
    mockApiClient.invoke.mockRejectedValue(new Error('Network error'));

    await service.runInternetCheck();

    expect(service.status()).toBe('offline');
    expect(service.result()).toEqual({ successful: [], failed: {}, retries_used: {} });
  });

  it('should keep at most 5 entries in history', async () => {
    for (let i = 0; i < 7; i++) {
      mockApiClient.invoke.mockResolvedValue({
        successful: [`https://test-${i}.com`],
        failed: {},
        retries_used: {},
      });
      await service.runInternetCheck();
    }

    expect(service.history().length).toBe(5);
    expect(service.history()[0].result.successful).toEqual(['https://test-6.com']);
  });

  it('should return correct tooltip based on status', () => {
    service.status.set('checking');
    expect(service.getTooltip()).toBe('Checking connection...');

    service.status.set('online');
    service.result.set(undefined);
    expect(service.getTooltip()).toBe('Connection online');

    service.status.set('offline');
    service.result.set({
      successful: [],
      failed: {
        'https://www.google.com': 'Error',
        'https://www.dropbox.com': 'Error',
        'https://onedrive.live.com': 'Error',
        'https://custom.service.org/test': 'Error',
      },
      retries_used: {},
    });

    const tooltip = service.getTooltip();
    expect(tooltip).toContain('Google Drive');
    expect(tooltip).toContain('Dropbox');
    expect(tooltip).toContain('OneDrive');
    expect(tooltip).toContain('custom.service.org');
  });
});
