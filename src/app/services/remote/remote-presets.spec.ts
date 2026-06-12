import { TestBed } from '@angular/core/testing';
import { RemotePresetsService } from './remote-presets';
import { BackendService } from '../infrastructure/system/backend.service';
import { UiStateService } from '../ui/state/ui-state.service';
import { signal } from '@angular/core';

describe('RemotePresetsService', () => {
  let service: RemotePresetsService;
  let mockBackendService: any;
  let mockUiStateService: any;

  beforeEach(() => {
    mockBackendService = {
      backends: signal([
        { name: 'Local', isLocal: true, os: 'linux' },
        { name: 'RemoteWindows', isLocal: false, os: 'windows' },
        { name: 'RemoteMac', isLocal: false, os: 'darwin' },
      ]),
      activeBackend: signal('Local'),
    };

    mockUiStateService = {
      platform: 'linux',
    };

    TestBed.configureTestingModule({
      providers: [
        RemotePresetsService,
        { provide: BackendService, useValue: mockBackendService },
        { provide: UiStateService, useValue: mockUiStateService },
      ],
    });
    service = TestBed.inject(RemotePresetsService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('getStorageFamily', () => {
    it('should map s3, b2, gcs to s3 family', () => {
      expect(service.getStorageFamily('s3')).toBe('s3');
      expect(service.getStorageFamily('b2')).toBe('s3');
      expect(service.getStorageFamily('gcs')).toBe('s3');
      expect(service.getStorageFamily('Google Cloud Storage')).toBe('s3');
    });

    it('should map webdav to webdav family', () => {
      expect(service.getStorageFamily('webdav')).toBe('webdav');
    });

    it('should map unknown remotes to generic family', () => {
      expect(service.getStorageFamily('sftp')).toBe('generic');
      expect(service.getStorageFamily('')).toBe('generic');
    });
  });

  describe('getTargetPlatform', () => {
    it('should return uiStateService platform if active backend is local', () => {
      mockBackendService.activeBackend.set('Local');
      mockUiStateService.platform = 'macos';
      expect(service.getTargetPlatform()).toBe('macos');
    });

    it('should return backend os if active backend is remote', () => {
      mockBackendService.activeBackend.set('RemoteWindows');
      expect(service.getTargetPlatform()).toBe('windows');
    });
  });

  describe('resolvePresets', () => {
    it('should apply BASE_PRESET by default', () => {
      const presets = service.resolvePresets('sftp');
      expect(presets.vfs?.['CacheMode']).toBe('full');
      expect(presets.backend?.['LogLevel']).toBe('INFO');
    });

    it('should merge family-specific presets', () => {
      const presets = service.resolvePresets('s3');
      // s3 overrides DisableHTTP2 to true and DirCacheTime to 72h
      expect(presets.backend?.['DisableHTTP2']).toBe(true);
      expect(presets.vfs?.['DirCacheTime']).toBe('72h');
      // base preset should still be there
      expect(presets.vfs?.['CacheMode']).toBe('full');
    });

    it('should merge provider-specific presets', () => {
      const presets = service.resolvePresets('b2');
      expect(presets.remote?.['disable_checksum']).toBe(true);
      expect(presets.remote?.['upload_concurrency']).toBe(8);
    });

    it('should merge vendor-specific presets for nextcloud', () => {
      const presets = service.resolvePresets('webdav', 'nextcloud');
      expect(presets.remote?.['nextcloud_chunk_size']).toBe('64M');
    });

    it('should merge vendor-specific presets for owncloud', () => {
      const presets = service.resolvePresets('webdav', 'owncloud');
      expect(presets.remote?.['nextcloud_chunk_size']).toBe('64M');
    });

    it('should merge OS-specific presets for windows', () => {
      mockUiStateService.platform = 'windows';
      mockBackendService.activeBackend.set('Local');
      const presets = service.resolvePresets('sftp');
      expect(presets.mount?.['NetworkMode']).toBe(true);
    });

    it('should merge OS-specific presets for macos', () => {
      mockUiStateService.platform = 'macos';
      mockBackendService.activeBackend.set('Local');
      const presets = service.resolvePresets('sftp');
      expect(presets.mount?.['NoAppleXattr']).toBe(true);
    });
  });
});
