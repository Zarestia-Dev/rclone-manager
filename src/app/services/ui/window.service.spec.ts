import { platform } from '@tauri-apps/plugin-os';
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
import { EventListenersService } from '../infrastructure/system/event-listeners.service';

vi.mock('@tauri-apps/plugin-os', () => ({ platform: vi.fn() }));

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
  let scaleSettingSubject: Subject<{ value: unknown } | null>;
  let setZoom: ReturnType<typeof vi.spyOn>;
  let sseEventSubject: Subject<unknown>;
  let layoutChanges: Subject<string | null>;
  let accentChanges: Subject<string | null>;
  let accentSetting: Subject<{ value: unknown }>;

  beforeEach(() => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))
    );

    themeSettingSubject = new Subject();
    scaleSettingSubject = new Subject();
    setZoom = vi
      .spyOn(
        WindowService.prototype as unknown as { setWebviewZoom: (f: number) => Promise<void> },
        'setWebviewZoom'
      )
      .mockResolvedValue(undefined);
    sseEventSubject = new Subject();
    layoutChanges = new Subject();
    accentChanges = new Subject();
    accentSetting = new Subject();

    mockAppSettings = {
      selectSetting: vi.fn((key: string) =>
        key === 'general.ui_scale'
          ? scaleSettingSubject.asObservable()
          : key === 'general.system_accent_color'
            ? accentSetting.asObservable()
            : themeSettingSubject.asObservable()
      ),
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
        {
          provide: EventListenersService,
          useValue: {
            listenToSystemThemeChanged: vi.fn().mockReturnValue(new Subject()),
            listenToWindowResize: vi.fn().mockReturnValue(new Subject()),
            listenToWindowButtonLayoutChanged: vi.fn(() => layoutChanges.asObservable()),
            listenToSystemAccentColorChanged: vi.fn(() => accentChanges.asObservable()),
          },
        },
      ],
    });

    service = TestBed.inject(WindowService);
  });

  afterEach(() => {
    document.documentElement.removeAttribute('class');
    document.documentElement.removeAttribute('data-system-accent');
    document.documentElement.removeAttribute('style');
    vi.unstubAllGlobals();
  });

  it.each(['android', 'ios'] as const)('does not call desktop window APIs on %s', async os => {
    const descriptor = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__');
    const osDescriptor = Object.getOwnPropertyDescriptor(window, '__TAURI_OS_PLUGIN_INTERNALS__');
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    Object.defineProperty(window, '__TAURI_OS_PLUGIN_INTERNALS__', {
      value: { platform: os },
      configurable: true,
    });
    vi.mocked(platform).mockReturnValue(os);
    const getWindowSpy = vi.spyOn(
      WindowService.prototype as unknown as { getCurrentTauriWindow: () => unknown },
      'getCurrentTauriWindow'
    );
    try {
      const mobile = TestBed.runInInjectionContext(() => new WindowService());
      expect(await mobile.isWindowMaximized()).toBe(false);
      await mobile.minimize();
      await mobile.maximize();
      await mobile.startResizeDragging('East');
      expect(getWindowSpy).not.toHaveBeenCalled();
      expect(TestBed.inject(EventListenersService).listenToWindowResize).not.toHaveBeenCalled();
      expect(TestBed.inject(EventListenersService).listenToSystemThemeChanged).toHaveBeenCalled();
    } finally {
      getWindowSpy.mockRestore();
      if (descriptor) Object.defineProperty(window, '__TAURI_INTERNALS__', descriptor);
      else Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
      if (osDescriptor)
        Object.defineProperty(window, '__TAURI_OS_PLUGIN_INTERNALS__', osDescriptor);
      else Reflect.deleteProperty(window, '__TAURI_OS_PLUGIN_INTERNALS__');
      vi.mocked(platform).mockReset();
    }
  });

  describe('window button layout', () => {
    const createDesktopService = async (
      os: 'linux' | 'windows',
      layout: Promise<unknown>
    ): Promise<WindowService> => {
      Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
      Object.defineProperty(window, '__TAURI_OS_PLUGIN_INTERNALS__', {
        value: { platform: os },
        configurable: true,
      });
      vi.mocked(platform).mockReturnValue(os);
      vi.spyOn(
        WindowService.prototype as unknown as { getCurrentTauriWindow: () => unknown },
        'getCurrentTauriWindow'
      ).mockReturnValue({ isMaximized: vi.fn().mockResolvedValue(false) });
      mockApiClient.invoke.mockImplementation((command: string) =>
        command === 'get_window_button_layout' ? layout : Promise.resolve({})
      );
      const desktop = TestBed.runInInjectionContext(() => new WindowService());
      await Promise.resolve();
      await Promise.resolve();
      return desktop;
    };

    afterEach(() => {
      Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
      Reflect.deleteProperty(window, '__TAURI_OS_PLUGIN_INTERNALS__');
      vi.mocked(platform).mockReset();
      vi.restoreAllMocks();
    });

    it('zooms the webview to the interface scale and follows changes', async () => {
      await createDesktopService('linux', Promise.resolve('appmenu:close'));
      scaleSettingSubject.next({ value: 80 });
      expect(setZoom).toHaveBeenLastCalledWith(0.8);
      scaleSettingSubject.next({ value: 150 });
      expect(setZoom).toHaveBeenLastCalledWith(1.5);
    });

    it('clamps the scale and ignores values that are not numbers', async () => {
      await createDesktopService('windows', Promise.resolve(null));
      scaleSettingSubject.next({ value: 500 });
      expect(setZoom).toHaveBeenLastCalledWith(2);
      scaleSettingSubject.next({ value: 10 });
      expect(setZoom).toHaveBeenLastCalledWith(0.5);
      setZoom.mockClear();
      scaleSettingSubject.next({ value: 'big' });
      scaleSettingSubject.next(null);
      expect(setZoom).not.toHaveBeenCalled();
    });

    it('does not zoom outside the desktop app', () => {
      // The default service runs without Tauri, like the headless web UI.
      scaleSettingSubject.next({ value: 80 });
      expect(setZoom).not.toHaveBeenCalled();
    });

    it('starts with minimize, maximize and close at the end', () => {
      expect(service.buttonLayout()).toEqual({ start: [], end: ['minimize', 'maximize', 'close'] });
    });

    it('follows the desktop layout on Linux', async () => {
      const desktop = await createDesktopService('linux', Promise.resolve('appmenu:close'));
      expect(mockApiClient.invoke).toHaveBeenCalledWith('get_window_button_layout', undefined);
      expect(desktop.buttonLayout()).toEqual({ start: [], end: ['close'] });
    });

    it('follows layout changes without a reload', async () => {
      const desktop = await createDesktopService('linux', Promise.resolve('appmenu:close'));
      layoutChanges.next('close,minimize,maximize:');
      expect(desktop.buttonLayout()).toEqual({ start: ['close', 'minimize', 'maximize'], end: [] });
      layoutChanges.next(null);
      expect(desktop.buttonLayout().end).toEqual(['minimize', 'maximize', 'close']);
      const reads = mockApiClient.invoke.mock.calls.filter(
        ([c]) => c === 'get_window_button_layout'
      );
      expect(reads).toHaveLength(1);
    });

    it('keeps a change that arrives before the first read returns', async () => {
      let answer: (layout: string) => void = () => undefined;
      const pending = new Promise<string>(resolve => (answer = resolve));
      const desktop = await createDesktopService('linux', pending);
      layoutChanges.next('close:');
      answer('appmenu:minimize,maximize,close');
      await Promise.resolve();
      await Promise.resolve();
      expect(desktop.buttonLayout()).toEqual({ start: ['close'], end: [] });
    });

    it('does not ask for a layout on Windows', async () => {
      const desktop = await createDesktopService('windows', Promise.resolve('close:'));
      const commands = mockApiClient.invoke.mock.calls.map(([command]) => command);
      expect(commands).not.toContain('get_window_button_layout');
      expect(
        TestBed.inject(EventListenersService).listenToWindowButtonLayoutChanged
      ).not.toHaveBeenCalled();
      expect(desktop.buttonLayout().end).toEqual(['minimize', 'maximize', 'close']);
    });

    it('keeps the default when the layout cannot be read', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const desktop = await createDesktopService('linux', Promise.reject(new Error('no GTK')));
      expect(desktop.buttonLayout().end).toEqual(['minimize', 'maximize', 'close']);
      expect(error).toHaveBeenCalled();
    });
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

  describe('system accent color', () => {
    const root = document.documentElement;
    const createDesktopService = async (
      os: 'linux' | 'windows',
      accent: Promise<unknown>
    ): Promise<WindowService> => {
      Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
      Object.defineProperty(window, '__TAURI_OS_PLUGIN_INTERNALS__', {
        value: { platform: os },
        configurable: true,
      });
      vi.mocked(platform).mockReturnValue(os);
      vi.spyOn(
        WindowService.prototype as unknown as { getCurrentTauriWindow: () => unknown },
        'getCurrentTauriWindow'
      ).mockReturnValue({ isMaximized: vi.fn().mockResolvedValue(false) });
      mockApiClient.invoke.mockImplementation((command: string) =>
        command === 'get_system_accent_color' ? accent : Promise.resolve(null)
      );
      const desktop = TestBed.runInInjectionContext(() => new WindowService());
      await Promise.resolve();
      await Promise.resolve();
      return desktop;
    };

    afterEach(() => {
      Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
      Reflect.deleteProperty(window, '__TAURI_OS_PLUGIN_INTERNALS__');
      vi.mocked(platform).mockReset();
      vi.restoreAllMocks();
    });

    it('uses the desktop accent color while the setting is on', async () => {
      await createDesktopService('linux', Promise.resolve('#3584e4'));
      expect(root.hasAttribute('data-system-accent')).toBe(false);
      accentSetting.next({ value: true });
      expect(root.hasAttribute('data-system-accent')).toBe(true);
      expect(root.style.getPropertyValue('--system-accent-bg')).toBe('#3584e4');
      expect(root.style.getPropertyValue('--system-accent-light')).toBe('#0461be');
      expect(root.style.getPropertyValue('--system-accent-dark')).toBe('#81d0ff');
      expect(root.style.getPropertyValue('--system-accent-bg-rgb')).toBe('53, 132, 228');
      accentSetting.next({ value: false });
      expect(root.hasAttribute('data-system-accent')).toBe(false);
    });

    it('follows accent changes, and drops the accent when the desktop has none', async () => {
      await createDesktopService('linux', Promise.resolve('#3584e4'));
      accentSetting.next({ value: true });
      accentChanges.next('#e01b24');
      expect(root.style.getPropertyValue('--system-accent-bg')).toBe('#e01b24');
      accentChanges.next(null);
      expect(root.hasAttribute('data-system-accent')).toBe(false);
    });

    it('keeps a change that arrives before the first read returns', async () => {
      let answer: (color: string) => void = () => undefined;
      const pending = new Promise<string>(resolve => (answer = resolve));
      await createDesktopService('linux', pending);
      accentSetting.next({ value: true });
      accentChanges.next('#2ec27e');
      answer('#3584e4');
      await Promise.resolve();
      await Promise.resolve();
      expect(root.style.getPropertyValue('--system-accent-bg')).toBe('#2ec27e');
    });

    it('does not ask for an accent color outside Linux', async () => {
      await createDesktopService('windows', Promise.resolve('#3584e4'));
      accentSetting.next({ value: true });
      const commands = mockApiClient.invoke.mock.calls.map(([command]) => command);
      expect(commands).not.toContain('get_system_accent_color');
      expect(root.hasAttribute('data-system-accent')).toBe(false);
    });
  });
});
