import { TestBed } from '@angular/core/testing';
import { computed } from '@angular/core';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { of } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { RemoteManagementService } from './remote-management.service';
import { RemoteFileOperationsService } from './remote-file-operations.service';
import { PathService } from '../infrastructure/platform/path.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { NotificationService } from '../ui/notification.service';
import { BackendTranslationService } from '../i18n/backend-translation.service';
import { SseClientService } from '../infrastructure/platform/sse-client.service';
import { FsInfo } from '@app/types';

describe('RemoteManagementService', () => {
  let service: RemoteManagementService;
  let remoteOpsSpy: {
    getFsInfo: ReturnType<typeof vi.fn>;
  };
  let pathService: PathService;

  const mockFsInfoDrive: FsInfo = {
    Name: 'drive',
    Root: '',
    Precision: 1,
    Hashes: ['MD5'],
    Features: {
      About: true,
      BucketBased: false,
      CanHaveEmptyDirectories: true,
      CleanUp: true,
      PublicLink: true,
      Copy: true,
      Move: true,
      Purge: true,
    },
  };

  beforeEach(() => {
    remoteOpsSpy = {
      getFsInfo: vi.fn().mockResolvedValue(mockFsInfoDrive),
    };

    TestBed.configureTestingModule({
      providers: [
        RemoteManagementService,
        PathService,
        { provide: RemoteFileOperationsService, useValue: remoteOpsSpy },
        {
          provide: ApiClientService,
          useValue: {
            invoke: vi.fn().mockResolvedValue([{ name: 'Local', isActive: true }]),
            get: vi.fn(),
            post: vi.fn(),
          },
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
          useValue: { translateError: vi.fn((k: string) => k) },
        },
        { provide: SseClientService, useValue: { listen: vi.fn(() => of()) } },
      ],
    });

    service = TestBed.inject(RemoteManagementService);
    pathService = TestBed.inject(PathService);
    pathService.setRemoteNames(['gdrive', 'localremote']);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('getFeaturesSignal', () => {
    it('should return initial fallback signal and trigger async load for cloud remote', async () => {
      const sig = service.getFeaturesSignal('gdrive', 'drive');
      expect(sig).toBeDefined();

      // Initial read returns fallback with loading: true
      const initial = sig();
      expect(initial.CleanUp).toBe(false);
      expect(initial.loading).toBe(true);

      // getFsInfo should be called in background
      expect(remoteOpsSpy.getFsInfo).toHaveBeenCalledWith('gdrive:', 'dashboard', undefined);

      // Wait for async getFeatures to complete
      await vi.waitFor(() => {
        expect(sig().loading).toBe(false);
      });

      const loaded = sig();
      expect(loaded.CleanUp).toBe(true);
      expect(loaded.PublicLink).toBe(true);
      expect(loaded.Purge).toBe(true);
      expect(loaded.Copy).toBe(true);
      expect(loaded.Move).toBe(true);
      expect(loaded.Hashes).toEqual(['MD5']);
    });

    it('should handle local paths synchronously without calling getFsInfo', () => {
      const sig = service.getFeaturesSignal('/home/user/documents');
      const feats = sig();
      expect(feats.IsLocal).toBe(true);
      expect(feats.loading).toBe(false);
      expect(remoteOpsSpy.getFsInfo).not.toHaveBeenCalled();
    });

    it('should reuse existing signal for the same cache key', () => {
      const sig1 = service.getFeaturesSignal('gdrive', 'drive');
      const sig2 = service.getFeaturesSignal('gdrive', 'drive');
      expect(sig1).toBe(sig2);
    });

    it('should not throw NG0600 when getFeaturesSignal is read inside a computed', async () => {
      const computedFeatures = computed(() => service.getFeaturesSignal('gdrive', 'drive')());

      expect(() => computedFeatures()).not.toThrow();
      expect(computedFeatures().loading).toBe(true);

      await vi.waitFor(() => {
        expect(computedFeatures().loading).toBe(false);
      });
      expect(computedFeatures().CleanUp).toBe(true);
    });
  });

  describe('hasFeature and publicLinkSupported', () => {
    it('should check features dynamically and return false while loading', async () => {
      expect(service.hasFeature('gdrive', 'CleanUp', 'drive')).toBe(false);
      expect(service.hasFeature('gdrive', 'Purge', 'drive')).toBe(false);

      await vi.waitFor(() => {
        expect(service.hasFeature('gdrive', 'CleanUp', 'drive')).toBe(true);
      });

      expect(service.hasFeature('gdrive', 'CleanUp', 'drive')).toBe(true);
      expect(service.hasFeature('gdrive', 'Purge', 'drive')).toBe(true);
      expect(service.hasFeature('gdrive', 'BucketBased', 'drive')).toBe(false);
      expect(service.hasFeature('gdrive', 'NonExistentFeature', 'drive')).toBe(false);
      expect(service.publicLinkSupported('gdrive')).toBe(true);
    });

    it('should not throw NG0600 when hasFeature is called inside a computed', async () => {
      const computedHasFeature = computed(() => service.hasFeature('gdrive', 'CleanUp', 'drive'));

      expect(() => computedHasFeature()).not.toThrow();
      expect(computedHasFeature()).toBe(false);

      await vi.waitFor(() => {
        expect(computedHasFeature()).toBe(true);
      });
    });
  });

  describe('getFeatures deduplication and error handling', () => {
    it('should deduplicate concurrent in-flight requests for the same remote', async () => {
      let resolveFirst!: (value: FsInfo) => void;
      remoteOpsSpy.getFsInfo.mockReturnValueOnce(
        new Promise<FsInfo>(res => {
          resolveFirst = res;
        })
      );

      const p1 = service.getFeatures('gdrive', 'drive');
      const p2 = service.getFeatures('gdrive', 'drive');

      expect(remoteOpsSpy.getFsInfo).toHaveBeenCalledTimes(1);

      resolveFirst(mockFsInfoDrive);
      const [res1, res2] = await Promise.all([p1, p2]);

      expect(res1).toEqual(res2);
      expect(res1.CleanUp).toBe(true);
      expect(res1.Purge).toBe(true);
    });

    it('should return fallback if getFsInfo fails', async () => {
      remoteOpsSpy.getFsInfo.mockRejectedValueOnce(new Error('Network error'));

      const feats = await service.getFeatures('gdrive', 'drive');
      expect(feats.CleanUp).toBe(false);
      expect(feats.loading).toBe(false);
      expect(feats.About).toBe(false);
    });
  });

  describe('clearCache', () => {
    it('should clear specific remote from cache and inFlight map', async () => {
      await service.getFeatures('gdrive', 'drive');
      expect(remoteOpsSpy.getFsInfo).toHaveBeenCalledTimes(1);

      service.clearCache('gdrive');

      // Subsequent call should fetch again
      await service.getFeatures('gdrive', 'drive');
      expect(remoteOpsSpy.getFsInfo).toHaveBeenCalledTimes(2);
    });
  });
});
