import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { of, Subject } from 'rxjs';
import { AppSettingsService } from './app-settings.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { NotificationService } from '../ui/notification.service';
import { TranslateService } from '@ngx-translate/core';
import { BackendTranslationService } from '../i18n/backend-translation.service';
import { SseClientService } from '../infrastructure/platform/sse-client.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { SettingMetadata, SettingsChangeEvent } from '@app/types';

describe('AppSettingsService', () => {
  let service: AppSettingsService;
  let apiClientMock: { invoke: ReturnType<typeof vi.fn> };
  let notificationMock: {
    showSuccess: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    confirmModal: ReturnType<typeof vi.fn>;
  };
  let translateMock: {
    instant: ReturnType<typeof vi.fn>;
    getCurrentLang: ReturnType<typeof vi.fn>;
    use: ReturnType<typeof vi.fn>;
  };
  let backendTranslationMock: { translateBackendMessage: ReturnType<typeof vi.fn> };
  let sseClientMock: { listen: ReturnType<typeof vi.fn> };
  let settingsChanged$: Subject<SettingsChangeEvent>;
  let langChanged$: Subject<string>;
  let eventListenersMock: {
    listenToSystemSettingsChanged: ReturnType<typeof vi.fn>;
    listenToLanguageChanged: ReturnType<typeof vi.fn>;
  };

  const createService = (): AppSettingsService => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        AppSettingsService,
        { provide: ApiClientService, useValue: apiClientMock },
        { provide: NotificationService, useValue: notificationMock },
        { provide: TranslateService, useValue: translateMock },
        { provide: BackendTranslationService, useValue: backendTranslationMock },
        { provide: SseClientService, useValue: sseClientMock },
        { provide: EventListenersService, useValue: eventListenersMock },
      ],
    });
    return TestBed.inject(AppSettingsService);
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    settingsChanged$ = new Subject<SettingsChangeEvent>();
    langChanged$ = new Subject<string>();

    apiClientMock = { invoke: vi.fn() };
    notificationMock = {
      showSuccess: vi.fn(),
      showError: vi.fn(),
      confirmModal: vi.fn(),
    };
    translateMock = {
      instant: vi.fn((key: string) => key),
      getCurrentLang: vi.fn().mockReturnValue('en-US'),
      use: vi.fn(),
    };
    backendTranslationMock = {
      translateBackendMessage: vi.fn((msg: unknown) => String(msg)),
    };
    sseClientMock = { listen: vi.fn().mockReturnValue(of()) };
    eventListenersMock = {
      listenToSystemSettingsChanged: vi.fn().mockReturnValue(settingsChanged$.asObservable()),
      listenToLanguageChanged: vi.fn().mockReturnValue(langChanged$.asObservable()),
    };

    // By default simulate desktop Tauri
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (X11; Linux x86_64)'
    );

    service = createService();
  });

  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('isTrayAvailable', () => {
    it('returns false initially when options are not loaded', () => {
      expect(service.isTrayAvailable()).toBe(false);
    });

    it('returns false in headless/web mode', async () => {
      delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      const headlessService = createService();

      apiClientMock.invoke.mockResolvedValueOnce({
        options: {
          'general.tray_enabled': {
            value: true,
            value_type: 'bool',
          } as unknown as SettingMetadata,
        },
      });

      await headlessService.loadSettings();
    });

    it('returns false on mobile platform even if general.tray_enabled is true', async () => {
      vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Linux; Android 14)'
      );
      const mobileService = createService();

      apiClientMock.invoke.mockResolvedValueOnce({
        options: {
          'general.tray_enabled': {
            value: true,
            value_type: 'bool',
          } as unknown as SettingMetadata,
        },
      });

      await mobileService.loadSettings();
    });

    it('returns true on desktop when general.tray_enabled is true', async () => {
      apiClientMock.invoke.mockResolvedValueOnce({
        options: {
          'general.tray_enabled': {
            value: true,
            value_type: 'bool',
          } as unknown as SettingMetadata,
        },
      });

      await service.loadSettings();
      expect(service.isTrayAvailable()).toBe(true);
    });

    it('returns false on desktop when general.tray_enabled is false', async () => {
      apiClientMock.invoke.mockResolvedValueOnce({
        options: {
          'general.tray_enabled': {
            value: false,
            value_type: 'bool',
          } as unknown as SettingMetadata,
        },
      });

      await service.loadSettings();
      expect(service.isTrayAvailable()).toBe(false);
    });

    it('reactively updates when settings change event is received', async () => {
      apiClientMock.invoke.mockResolvedValueOnce({
        options: {
          'general.tray_enabled': {
            value: true,
            value_type: 'bool',
          } as unknown as SettingMetadata,
        },
      });

      await service.loadSettings();
      expect(service.isTrayAvailable()).toBe(true);

      // Simulate user disabling tray via preferences
      settingsChanged$.next({
        category: 'general',
        key: 'tray_enabled',
        value: false,
      });

      expect(service.isTrayAvailable()).toBe(false);

      // Re-enable tray
      settingsChanged$.next({
        category: 'general',
        key: 'tray_enabled',
        value: true,
      });

      expect(service.isTrayAvailable()).toBe(true);
    });

    it('re-applies saved language and reloads settings when wildcard settings change event is received', async () => {
      apiClientMock.invoke.mockResolvedValue({
        options: {
          'general.language': {
            value: 'fr-FR',
            value_type: 'string',
          } as unknown as SettingMetadata,
        },
      });

      await service.loadSettings();
      const applyLangSpy = vi.spyOn(service, 'applySavedLanguage');

      settingsChanged$.next({
        category: '*',
        key: '*',
        value: null,
      });

      expect(applyLangSpy).toHaveBeenCalled();
    });
  });
});
