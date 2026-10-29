import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AndroidStorageAccessService } from './android-storage-access.service';

describe('AndroidStorageAccessService', () => {
  let service: AndroidStorageAccessService;
  let mockBridge: {
    isAllFilesAccessGranted: ReturnType<typeof vi.fn>;
    requestAllFilesAccess: ReturnType<typeof vi.fn>;
  };

  const setup = (userAgent = 'Mozilla/5.0 (Linux; Android 14; Pixel 7)'): void => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    TestBed.configureTestingModule({
      providers: [
        AndroidStorageAccessService,
        { provide: TranslateService, useValue: { instant: vi.fn((key: string) => key) } },
      ],
    });
    service = TestBed.inject(AndroidStorageAccessService);
  };

  beforeEach(() => {
    mockBridge = {
      isAllFilesAccessGranted: vi.fn().mockReturnValue(false),
      requestAllFilesAccess: vi.fn(),
    };
    vi.stubGlobal('__rclone__', mockBridge);
    vi.stubGlobal('__TAURI_INTERNALS__', {});
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('prompts only while all files access is missing', () => {
    setup();
    expect(service.showAllFilesAccessPrompt()).toBe(false);

    service.initialize();
    expect(mockBridge.isAllFilesAccessGranted).toHaveBeenCalled();
    expect(service.showAllFilesAccessPrompt()).toBe(true);

    mockBridge.isAllFilesAccessGranted.mockReturnValue(true);
    service.refreshAllFilesAccess();
    expect(service.showAllFilesAccessPrompt()).toBe(false);
  });

  it('rechecks access when the app becomes visible again', () => {
    setup();
    service.initialize();
    mockBridge.isAllFilesAccessGranted.mockClear();
    mockBridge.isAllFilesAccessGranted.mockReturnValue(true);

    document.dispatchEvent(new Event('visibilitychange'));

    expect(mockBridge.isAllFilesAccessGranted).toHaveBeenCalled();
    expect(service.showAllFilesAccessPrompt()).toBe(false);
  });

  it('remembers a dismissed prompt', () => {
    setup();
    service.initialize();
    service.dismissAllFilesAccessPrompt();
    expect(service.showAllFilesAccessPrompt()).toBe(false);
    expect(localStorage.getItem('rcman.android.storagePromptDismissed')).toBe('true');
  });

  it('forwards the request to the native bridge', () => {
    setup();
    service.requestAllFilesAccess();
    expect(mockBridge.requestAllFilesAccess).toHaveBeenCalledTimes(1);
  });

  it('does nothing outside Android', () => {
    setup('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    service.initialize();
    expect(mockBridge.isAllFilesAccessGranted).not.toHaveBeenCalled();
    expect(service.showAllFilesAccessPrompt()).toBe(false);
  });

  it('keeps working when an older native bridge lacks the methods', () => {
    vi.stubGlobal('__rclone__', {});
    setup();
    service.initialize();
    service.requestAllFilesAccess();
    expect(service.showAllFilesAccessPrompt()).toBe(false);
  });
});
