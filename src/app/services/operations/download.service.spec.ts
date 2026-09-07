import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { DownloadService } from './download.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { NotificationService } from '../ui/notification.service';
import { FileViewerService } from '../ui/file-viewer.service';

describe('DownloadService', () => {
  let service: DownloadService;
  let apiClientMock: {
    invoke: ReturnType<typeof vi.fn>;
  };
  let notificationServiceMock: {
    showInfo: ReturnType<typeof vi.fn>;
    showSuccess: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
  };
  let fileViewerServiceMock: {
    generateUrl: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    apiClientMock = {
      invoke: vi.fn(),
    };
    notificationServiceMock = {
      showInfo: vi.fn(),
      showSuccess: vi.fn(),
      showError: vi.fn(),
    };
    fileViewerServiceMock = {
      generateUrl: vi.fn().mockResolvedValue('https://example.com/file.txt'),
    };

    TestBed.configureTestingModule({
      providers: [
        DownloadService,
        { provide: ApiClientService, useValue: apiClientMock },
        { provide: NotificationService, useValue: notificationServiceMock },
        { provide: FileViewerService, useValue: fileViewerServiceMock },
        { provide: TranslateService, useValue: { instant: (k: string): string => k } },
      ],
    });

    service = TestBed.inject(DownloadService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('download in Tauri mode', () => {
    beforeEach(() => {
      Object.defineProperty(service, 'isTauri', { value: true, configurable: true });
    });

    it('should do nothing if save location prompt is cancelled', async () => {
      apiClientMock.invoke.mockResolvedValueOnce(null);

      await service.download('my-remote', 'folder/file.txt', 'file.txt', false);

      expect(apiClientMock.invoke).toHaveBeenCalledWith('get_save_file_location', {
        defaultName: 'file.txt',
      });
      expect(apiClientMock.invoke).not.toHaveBeenCalledWith('download_file', expect.anything());
      expect(notificationServiceMock.showSuccess).not.toHaveBeenCalled();
    });

    it('should download file when save location is chosen', async () => {
      apiClientMock.invoke
        .mockResolvedValueOnce('/home/user/Downloads/file.txt')
        .mockResolvedValueOnce(undefined);

      await service.download('my-remote', 'folder/file.txt', 'file.txt', false, 1024);

      expect(apiClientMock.invoke).toHaveBeenCalledWith('get_save_file_location', {
        defaultName: 'file.txt',
      });
      expect(apiClientMock.invoke).toHaveBeenCalledWith('download_file', {
        remote: 'my-remote',
        path: 'folder/file.txt',
        destination: '/home/user/Downloads/file.txt',
        totalSize: 1024,
        isLocal: false,
      });
      expect(notificationServiceMock.showInfo).toHaveBeenCalled();
      expect(notificationServiceMock.showSuccess).toHaveBeenCalled();
    });

    it('should show error notification and throw if download_file fails', async () => {
      apiClientMock.invoke
        .mockResolvedValueOnce('/home/user/Downloads/file.txt')
        .mockRejectedValueOnce(new Error('Disk full'));

      await expect(
        service.download('my-remote', 'folder/file.txt', 'file.txt', false)
      ).rejects.toThrow('Disk full');

      expect(notificationServiceMock.showError).toHaveBeenCalled();
    });
  });

  describe('download in headless mode', () => {
    beforeEach(() => {
      Object.defineProperty(service, 'isTauri', { value: false, configurable: true });
    });

    it('should trigger browser download via link element', async () => {
      const clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation((): void => undefined);

      await service.download('remote', 'path/doc.pdf', 'doc.pdf', false);

      expect(fileViewerServiceMock.generateUrl).toHaveBeenCalled();
      expect(clickSpy).toHaveBeenCalled();
      expect(notificationServiceMock.showInfo).toHaveBeenCalled();
    });
  });

  describe('native file actions', () => {
    it('openFileNatively calls open_file_natively with action open', async () => {
      apiClientMock.invoke.mockResolvedValueOnce('/tmp/cached_file.txt');

      await service.openFileNatively('remote', 'path/file.txt', 'file.txt', false);

      expect(apiClientMock.invoke).toHaveBeenCalledWith('open_file_natively', {
        remote: 'remote',
        path: 'path/file.txt',
        fileName: 'file.txt',
        isLocal: false,
      });
      expect(notificationServiceMock.showInfo).toHaveBeenCalled();
    });

    it('shareFileNatively calls open_file_natively with action share', async () => {
      apiClientMock.invoke.mockResolvedValueOnce('/tmp/cached_file.txt');

      await service.shareFileNatively('remote', 'path/file.txt', 'file.txt', false);

      expect(apiClientMock.invoke).toHaveBeenCalledWith('open_file_natively', {
        remote: 'remote',
        path: 'path/file.txt',
        fileName: 'file.txt',
        isLocal: false,
      });
      expect(notificationServiceMock.showInfo).toHaveBeenCalled();
    });
  });
});
