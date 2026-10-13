import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TranslateService } from '@ngx-translate/core';
import { AndroidKeepAliveService } from './android-keep-alive.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { MountManagementService } from '../../operations/mount-management.service';
import { JobManagementService } from '../../operations/job-management.service';
import { ServeManagementService } from '../../operations/serve-management.service';
import { JobInfo, MountedRemote, ServeListItem } from '@app/types';

describe('AndroidKeepAliveService', () => {
  let service: AndroidKeepAliveService;
  let mountedRemotesSignal: ReturnType<typeof signal<MountedRemote[]>>;
  let activeJobsSignal: ReturnType<typeof signal<JobInfo[]>>;
  let runningServesSignal: ReturnType<typeof signal<ServeListItem[]>>;

  let mockAppSettings: {
    selectSetting: ReturnType<typeof vi.fn>;
    saveSetting: ReturnType<typeof vi.fn>;
  };
  let mockTranslate: {
    instant: ReturnType<typeof vi.fn>;
  };
  let mockBridge: {
    isBatteryOptimizationIgnored: ReturnType<typeof vi.fn>;
    requestIgnoreBatteryOptimizations: ReturnType<typeof vi.fn>;
    startKeepAliveService: ReturnType<typeof vi.fn>;
    stopKeepAliveService: ReturnType<typeof vi.fn>;
    isKeepAliveServiceRunning: ReturnType<typeof vi.fn>;
    updateKeepAliveNotification: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mountedRemotesSignal = signal<MountedRemote[]>([]);
    activeJobsSignal = signal<JobInfo[]>([]);
    runningServesSignal = signal<ServeListItem[]>([]);

    mockAppSettings = {
      selectSetting: vi.fn().mockReturnValue(of({ value: true })),
      saveSetting: vi.fn().mockResolvedValue(undefined),
    };

    mockTranslate = {
      instant: vi.fn((key: string) => key),
    };

    mockBridge = {
      isBatteryOptimizationIgnored: vi.fn().mockReturnValue(true),
      requestIgnoreBatteryOptimizations: vi.fn(),
      startKeepAliveService: vi.fn(),
      stopKeepAliveService: vi.fn(),
      isKeepAliveServiceRunning: vi.fn().mockReturnValue(true),
      updateKeepAliveNotification: vi.fn(),
    };

    (window as Window & { __rclone__?: unknown }).__rclone__ = mockBridge;
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Linux; Android 14; Pixel 7)'
    );

    TestBed.configureTestingModule({
      providers: [
        AndroidKeepAliveService,
        { provide: AppSettingsService, useValue: mockAppSettings },
        { provide: TranslateService, useValue: mockTranslate },
        {
          provide: MountManagementService,
          useValue: { mountedRemotes: mountedRemotesSignal.asReadonly() },
        },
        {
          provide: JobManagementService,
          useValue: { activeJobs: activeJobsSignal.asReadonly() },
        },
        {
          provide: ServeManagementService,
          useValue: { runningServes: runningServesSignal.asReadonly() },
        },
      ],
    });

    service = TestBed.inject(AndroidKeepAliveService);
  });

  afterEach(() => {
    delete (window as Window & { __rclone__?: unknown }).__rclone__;
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should initialize and check battery optimization on Android', () => {
    service.initialize();

    expect(mockBridge.isBatteryOptimizationIgnored).toHaveBeenCalled();
    expect(service.isBatteryOptimizationIgnored()).toBe(true);
    expect(mockAppSettings.selectSetting).toHaveBeenCalledWith('general.keep_alive');
  });

  it('should forward request to ignore battery optimizations', () => {
    service.requestIgnoreBatteryOptimizations();
    expect(mockBridge.requestIgnoreBatteryOptimizations).toHaveBeenCalled();
  });

  it('should save keep_alive setting when toggled', async () => {
    await service.toggleKeepAliveSetting(false);

    expect(service.isKeepAliveSettingEnabled()).toBe(false);
    expect(mockAppSettings.saveSetting).toHaveBeenCalledWith('general', 'keep_alive', false);
  });

  it('should start keep-alive service when initialized with keep-alive enabled', async () => {
    service.initialize();
    TestBed.tick();

    expect(mockBridge.startKeepAliveService).toHaveBeenCalledWith(true);
    expect(mockBridge.updateKeepAliveNotification).toHaveBeenCalledWith(
      'RClone Manager',
      'settings.general.keep_alive.label'
    );
    expect(service.isServiceRunning()).toBe(true);
  });

  it('should debounce and update notification text when active jobs or mounts exist', () => {
    service.initialize();
    TestBed.tick();

    mountedRemotesSignal.set([
      { fs: 'remote:', mount_point: '/mnt/remote' } as unknown as MountedRemote,
    ]);
    activeJobsSignal.set([{ jobid: 1, status: 'Running' } as JobInfo]);
    TestBed.tick();

    // Before debounce time elapses, notification should not have updated with new text
    expect(mockBridge.updateKeepAliveNotification).not.toHaveBeenCalledWith(
      'RClone Manager',
      '1 active jobs • 1 mounted'
    );

    // Fast-forward past the 500ms debounce
    vi.advanceTimersByTime(500);

    expect(mockBridge.updateKeepAliveNotification).toHaveBeenCalledWith(
      'RClone Manager',
      '1 active jobs • 1 mounted'
    );
  });

  it('should coalesce rapid multiple operations changes into a single notification update', () => {
    service.initialize();
    TestBed.tick();

    mockBridge.updateKeepAliveNotification.mockClear();

    // Fire multiple rapid updates
    activeJobsSignal.set([{ jobid: 1, status: 'Running' } as JobInfo]);
    TestBed.tick();
    vi.advanceTimersByTime(100);

    mountedRemotesSignal.set([
      { fs: 'remote:', mount_point: '/mnt/remote' } as unknown as MountedRemote,
    ]);
    TestBed.tick();
    vi.advanceTimersByTime(100);

    runningServesSignal.set([{ name: 'webdav' } as unknown as ServeListItem]);
    TestBed.tick();

    expect(mockBridge.updateKeepAliveNotification).not.toHaveBeenCalled();

    // Advance remaining debounce time
    vi.advanceTimersByTime(500);

    expect(mockBridge.updateKeepAliveNotification).toHaveBeenCalledTimes(1);
    expect(mockBridge.updateKeepAliveNotification).toHaveBeenCalledWith(
      'RClone Manager',
      '1 active jobs • 1 mounted • 1 serves'
    );
  });

  it('should skip redundant calls if state has not changed', () => {
    service.initialize();
    TestBed.tick();

    mockBridge.startKeepAliveService.mockClear();
    mockBridge.updateKeepAliveNotification.mockClear();

    // Trigger effect without changing values
    TestBed.tick();
    vi.advanceTimersByTime(500);

    expect(mockBridge.startKeepAliveService).not.toHaveBeenCalled();
    expect(mockBridge.updateKeepAliveNotification).not.toHaveBeenCalled();
  });

  it('should update notification text when active operations change even while backgrounded', () => {
    service.initialize();
    TestBed.tick();

    mockBridge.updateKeepAliveNotification.mockClear();

    // Simulate app in background
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);

    activeJobsSignal.set([{ jobid: 1, status: 'Running' } as JobInfo]);
    TestBed.tick();
    vi.advanceTimersByTime(500);

    // Notification update is dispatched so status bar reflects active job
    expect(mockBridge.updateKeepAliveNotification).toHaveBeenCalledWith(
      'RClone Manager',
      '1 active jobs'
    );
  });

  it('should stop service when keep-alive is disabled and no active operations exist', () => {
    mockAppSettings.selectSetting.mockReturnValue(of({ value: false }));
    service.initialize();
    TestBed.tick();

    expect(mockBridge.stopKeepAliveService).toHaveBeenCalledWith(true);
    expect(service.isServiceRunning()).toBe(false);
  });
});
