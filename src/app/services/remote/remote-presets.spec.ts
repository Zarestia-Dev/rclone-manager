import { TestBed } from '@angular/core/testing';
import { RemotePresetsService } from './remote-presets';
import { BackendService } from '../infrastructure/system/backend.service';
import { signal } from '@angular/core';

describe('RemotePresetsService', () => {
  let service: RemotePresetsService;
  let mockBackendService: any;

  beforeEach(() => {
    mockBackendService = {
      backends: signal([
        { name: 'Local', isLocal: true, os: 'linux' },
        { name: 'RemoteWindows', isLocal: false, os: 'windows' },
        { name: 'RemoteMac', isLocal: false, os: 'darwin' },
      ]),
      activeBackend: signal('Local'),
    };

    TestBed.configureTestingModule({
      providers: [RemotePresetsService, { provide: BackendService, useValue: mockBackendService }],
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
    it('should return the active backend engine-reported OS for local backends', () => {
      mockBackendService.activeBackend.set('Local');
      // Local backend runs the rclone engine on this host; its OS is reported
      // by rclone's `core/version` and surfaced as `BackendInfo.os`. We no
      // longer fall back to the *client* OS — the engine OS is canonical.
      mockBackendService.backends.set([{ name: 'Local', isLocal: true, os: 'windows' }]);
      expect(service.getTargetPlatform()).toBe('windows');
    });

    it('should return backend os if active backend is remote', () => {
      mockBackendService.activeBackend.set('RemoteWindows');
      expect(service.getTargetPlatform()).toBe('windows');
    });

    it('should fall back to linux when engine OS is missing', () => {
      mockBackendService.activeBackend.set('UnknownBackend');
      expect(service.getTargetPlatform()).toBe('linux');
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
      expect(presets.backend?.['DisableHTTP2']).toBe(true);
      expect(presets.vfs?.['FastFingerprint']).toBe(true);
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

    it('should merge OS-specific presets for windows engine', () => {
      mockBackendService.backends.set([{ name: 'Local', isLocal: true, os: 'windows' }]);
      mockBackendService.activeBackend.set('Local');
      const presets = service.resolvePresets('sftp');
      expect(presets.mount?.['NetworkMode']).toBe(true);
    });

    it('should merge OS-specific presets for macos engine', () => {
      mockBackendService.backends.set([{ name: 'Local', isLocal: true, os: 'darwin' }]);
      mockBackendService.activeBackend.set('Local');
      const presets = service.resolvePresets('sftp');
      expect(presets.mount?.['NoAppleXattr']).toBe(true);
      expect(presets.mount?.['NoAppleDouble']).toBe(true);
    });

    it('should not apply windows presets when client is windows but engine is linux (WSL)', () => {
      // Regression: previously the local-backend path fell back to the client
      // OS, so a Linux rclone engine driven from a Windows client would
      // incorrectly get NetworkMode=true. Engine OS is now the only signal.
      mockBackendService.backends.set([{ name: 'Local', isLocal: true, os: 'linux' }]);
      mockBackendService.activeBackend.set('Local');
      const presets = service.resolvePresets('sftp');
      expect(presets.mount?.['NetworkMode']).toBeUndefined();
    });
  });
});
