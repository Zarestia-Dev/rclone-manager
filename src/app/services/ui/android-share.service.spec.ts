import { TestBed } from '@angular/core/testing';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AndroidShareService } from './android-share.service';
import { NautilusService } from './nautilus.service';

describe('AndroidShareService', () => {
  let service: AndroidShareService;
  let mockNautilusService: {
    newNautilusWindow: ReturnType<typeof vi.fn>;
  };
  let mockBridge: {
    getPendingSharedFiles: ReturnType<typeof vi.fn>;
    getPendingRoute: ReturnType<typeof vi.fn>;
    clearSharedFiles: ReturnType<typeof vi.fn>;
    notifyFrontendReady: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockNautilusService = {
      newNautilusWindow: vi.fn().mockResolvedValue(undefined),
    };

    mockBridge = {
      getPendingSharedFiles: vi.fn().mockReturnValue('[]'),
      getPendingRoute: vi.fn().mockReturnValue(''),
      clearSharedFiles: vi.fn(),
      notifyFrontendReady: vi.fn(),
    };

    (window as Window & { __rclone__?: unknown }).__rclone__ = mockBridge;

    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Linux; Android 14; Pixel 7)'
    );

    TestBed.configureTestingModule({
      providers: [AndroidShareService, { provide: NautilusService, useValue: mockNautilusService }],
    });

    service = TestBed.inject(AndroidShareService);
  });

  afterEach(() => {
    delete (window as Window & { __rclone__?: unknown }).__rclone__;
    vi.restoreAllMocks();
  });

  it('should initialize and retrieve cold start pending files when present', () => {
    mockBridge.getPendingSharedFiles.mockReturnValue(
      JSON.stringify(['/cache/shared_files/photo1.jpg', '/cache/shared_files/photo2.jpg'])
    );

    service.initialize();

    expect(mockBridge.getPendingSharedFiles).toHaveBeenCalled();
    expect(mockBridge.notifyFrontendReady).toHaveBeenCalled();
    expect(service.pendingSharedPaths()).toEqual([
      '/cache/shared_files/photo1.jpg',
      '/cache/shared_files/photo2.jpg',
    ]);
    expect(mockNautilusService.newNautilusWindow).toHaveBeenCalledWith(null, null);
  });

  it('should initialize and open Nautilus when cold start route is nautilus', () => {
    mockBridge.getPendingRoute.mockReturnValue('nautilus');

    service.initialize();

    expect(mockBridge.getPendingRoute).toHaveBeenCalled();
    expect(mockNautilusService.newNautilusWindow).toHaveBeenCalledWith(null, null);
  });

  it('should handle runtime android-share-files CustomEvent during warm start', () => {
    service.initialize();
    expect(service.pendingSharedPaths()).toEqual([]);

    window.dispatchEvent(
      new CustomEvent('android-share-files', {
        detail: { paths: ['/cache/shared_files/incoming.pdf'] },
      })
    );

    expect(service.pendingSharedPaths()).toEqual(['/cache/shared_files/incoming.pdf']);
    expect(mockNautilusService.newNautilusWindow).toHaveBeenCalledWith(null, null);
  });

  it('should ignore android-share-files event with empty paths', () => {
    service.initialize();

    window.dispatchEvent(
      new CustomEvent('android-share-files', {
        detail: { paths: [] },
      })
    );

    expect(service.pendingSharedPaths()).toEqual([]);
  });

  it('should handle runtime android-navigate-route CustomEvent', () => {
    service.initialize();

    window.dispatchEvent(
      new CustomEvent('android-navigate-route', {
        detail: { route: 'nautilus' },
      })
    );

    expect(mockNautilusService.newNautilusWindow).toHaveBeenCalledWith(null, null);
  });

  it('should consume pending paths and reset queue', () => {
    mockBridge.getPendingSharedFiles.mockReturnValue(
      JSON.stringify(['/cache/shared_files/doc.txt'])
    );
    service.initialize();

    const consumed = service.consumePendingPaths();

    expect(consumed).toEqual(['/cache/shared_files/doc.txt']);
    expect(service.pendingSharedPaths()).toEqual([]);
  });

  it('should clear pending paths and call native clearSharedFiles on cancel', () => {
    mockBridge.getPendingSharedFiles.mockReturnValue(
      JSON.stringify(['/cache/shared_files/doc.txt'])
    );
    service.initialize();

    service.cancelPendingShare();

    expect(service.pendingSharedPaths()).toEqual([]);
    expect(mockBridge.clearSharedFiles).toHaveBeenCalled();
  });

  it('should not initialize if isMobile returns false', () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    );

    service.initialize();

    expect(mockBridge.getPendingSharedFiles).not.toHaveBeenCalled();
    expect(mockBridge.notifyFrontendReady).not.toHaveBeenCalled();
  });
});
