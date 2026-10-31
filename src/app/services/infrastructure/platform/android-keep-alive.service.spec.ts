import { TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TranslateService } from '@ngx-translate/core';
import { AndroidKeepAliveService } from './android-keep-alive.service';
import { AppSettingsService } from '../../settings/app-settings.service';

describe('AndroidKeepAliveService', () => {
  let service: AndroidKeepAliveService;
  let keepAliveSetting: BehaviorSubject<{ value: boolean }>;

  let mockAppSettings: {
    selectSetting: ReturnType<typeof vi.fn>;
  };
  let mockBridge: {
    isBatteryOptimizationIgnored: ReturnType<typeof vi.fn>;
    requestIgnoreBatteryOptimizations: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    keepAliveSetting = new BehaviorSubject<{ value: boolean }>({ value: true });

    mockAppSettings = {
      selectSetting: vi.fn().mockReturnValue(keepAliveSetting),
    };

    mockBridge = {
      isBatteryOptimizationIgnored: vi.fn().mockReturnValue(true),
      requestIgnoreBatteryOptimizations: vi.fn(),
    };

    vi.stubGlobal('__rclone__', mockBridge);
    vi.stubGlobal('__TAURI_INTERNALS__', {});

    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Linux; Android 14; Pixel 7)'
    );

    TestBed.configureTestingModule({
      providers: [
        AndroidKeepAliveService,
        { provide: AppSettingsService, useValue: mockAppSettings },
        { provide: TranslateService, useValue: { instant: (key: string): string => key } },
      ],
    });

    service = TestBed.inject(AndroidKeepAliveService);
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('should initialize and check battery optimization on Android', () => {
    service.initialize();

    expect(mockBridge.isBatteryOptimizationIgnored).toHaveBeenCalled();
    expect(service.isBatteryOptimizationIgnored()).toBe(true);
    expect(mockAppSettings.selectSetting).toHaveBeenCalledWith('general.keep_alive');
  });

  it('prompts for the exemption only while keep-alive is on and the app is not exempt', () => {
    mockBridge.isBatteryOptimizationIgnored.mockReturnValue(false);
    service.initialize();
    expect(service.showBatteryOptimizationPrompt()).toBe(true);

    keepAliveSetting.next({ value: false });
    expect(service.showBatteryOptimizationPrompt()).toBe(false);

    keepAliveSetting.next({ value: true });
    mockBridge.isBatteryOptimizationIgnored.mockReturnValue(true);
    service.refreshBatteryOptimizationStatus();
    expect(service.showBatteryOptimizationPrompt()).toBe(false);
  });

  it('remembers a dismissed battery prompt', () => {
    mockBridge.isBatteryOptimizationIgnored.mockReturnValue(false);
    service.initialize();
    service.dismissBatteryOptimizationPrompt();
    expect(service.showBatteryOptimizationPrompt()).toBe(false);
    expect(localStorage.getItem('rcman.android.batteryPromptDismissed')).toBe('true');
  });

  it('rechecks the exemption when the app becomes visible again', () => {
    service.initialize();
    mockBridge.isBatteryOptimizationIgnored.mockClear();
    mockBridge.isBatteryOptimizationIgnored.mockReturnValue(false);

    document.dispatchEvent(new Event('visibilitychange'));

    expect(mockBridge.isBatteryOptimizationIgnored).toHaveBeenCalled();
    expect(service.isBatteryOptimizationIgnored()).toBe(false);
  });

  it('should forward request to ignore battery optimizations', () => {
    service.requestIgnoreBatteryOptimizations();
    expect(mockBridge.requestIgnoreBatteryOptimizations).toHaveBeenCalled();
  });
});
