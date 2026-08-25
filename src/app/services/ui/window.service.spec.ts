import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WindowService } from './window.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { SseClientService } from '../infrastructure/platform/sse-client.service';
import { NotificationService } from './notification.service';
import { TranslateService } from '@ngx-translate/core';
import { BackendTranslationService } from '../i18n/backend-translation.service';

describe('WindowService', () => {
  let service: WindowService;
  let mockAppSettings: {
    selectSetting: ReturnType<typeof vi.fn>;
    saveSetting: ReturnType<typeof vi.fn>;
  };
  let mockApiClient: {
    invoke: ReturnType<typeof vi.fn>;
  };
  let themeSettingSubject: Subject<{ value: string } | null>;
  let sseEventSubject: Subject<unknown>;

  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    themeSettingSubject = new Subject();
    sseEventSubject = new Subject();

    mockAppSettings = {
      selectSetting: vi.fn().mockReturnValue(themeSettingSubject.asObservable()),
      saveSetting: vi.fn().mockResolvedValue(undefined),
    };

    mockApiClient = {
      invoke: vi.fn().mockResolvedValue({}),
    };

    TestBed.configureTestingModule({
      providers: [
        WindowService,
        { provide: AppSettingsService, useValue: mockAppSettings },
        { provide: ApiClientService, useValue: mockApiClient },
        {
          provide: SseClientService,
          useValue: { listen: vi.fn().mockReturnValue(sseEventSubject.asObservable()) },
        },
        {
          provide: NotificationService,
          useValue: { showSuccess: vi.fn(), showError: vi.fn(), showInfo: vi.fn() },
        },
        {
          provide: TranslateService,
          useValue: { instant: vi.fn((k: string) => k), get: vi.fn(() => of('')) },
        },
        {
          provide: BackendTranslationService,
          useValue: { translateBackendMessage: vi.fn((k: string) => k) },
        },
      ],
    });

    service = TestBed.inject(WindowService);
  });

  afterEach(() => {
    document.documentElement.removeAttribute('class');
  });

  it('should be created with default system theme', () => {
    expect(service).toBeTruthy();
    expect(service.theme()).toBe('system');
  });

  it('should update theme when runtime.theme setting changes', () => {
    themeSettingSubject.next({ value: 'dark' });
    expect(service.theme()).toBe('dark');
    expect(document.documentElement.getAttribute('class')).toBe('dark');

    themeSettingSubject.next({ value: 'light' });
    expect(service.theme()).toBe('light');
    expect(document.documentElement.getAttribute('class')).toBe('light');
  });

  it('should save setting when setTheme is called with a new theme', async () => {
    themeSettingSubject.next({ value: 'system' });
    await service.setTheme('dark');

    expect(mockAppSettings.saveSetting).toHaveBeenCalledWith('runtime', 'theme', 'dark');
  });

  it('should not save setting when setTheme is called with current theme', async () => {
    themeSettingSubject.next({ value: 'dark' });
    mockAppSettings.saveSetting.mockClear();

    await service.setTheme('dark');
    expect(mockAppSettings.saveSetting).not.toHaveBeenCalled();
  });

  it('should invoke set_theme command on backend when applyTheme is called', async () => {
    await service.applyTheme('dark');

    expect(mockApiClient.invoke).toHaveBeenCalledWith('set_theme', {
      theme: 'dark',
      systemIsDark: expect.any(Boolean),
    });
  });

  it('should react to SYSTEM_THEME_CHANGED event when in system mode', () => {
    themeSettingSubject.next({ value: 'system' });

    const themeChangeSubject = new Subject<boolean>();
    themeChangeSubject.subscribe(isDark => {
      if (service.theme() === 'system') {
        document.documentElement.setAttribute('class', isDark ? 'dark' : 'light');
      }
    });

    themeChangeSubject.next(true);
    expect(document.documentElement.getAttribute('class')).toBe('dark');

    themeChangeSubject.next(false);
    expect(document.documentElement.getAttribute('class')).toBe('light');
  });

  it('should quit application by invoking request_app_exit', async () => {
    await service.quitApplication();
    expect(mockApiClient.invoke).toHaveBeenCalledWith('request_app_exit', undefined);
  });
});
