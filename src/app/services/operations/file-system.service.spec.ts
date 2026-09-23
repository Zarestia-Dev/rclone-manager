import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { FileSystemService } from './file-system.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { NotificationService } from '../ui/notification.service';
import { NautilusService } from '../ui/nautilus.service';
import { BackendService } from '../infrastructure/system/backend.service';
import { PathService } from '../infrastructure/platform/path.service';

describe('FileSystemService', () => {
  let service: FileSystemService;
  let apiClientMock: {
    invoke: ReturnType<typeof vi.fn>;
  };
  let notificationServiceMock: {
    showError: ReturnType<typeof vi.fn>;
    confirmModal: ReturnType<typeof vi.fn>;
  };
  let nautilusServiceMock: {
    newNautilusWindow: ReturnType<typeof vi.fn>;
    openFilePicker: ReturnType<typeof vi.fn>;
    filePickerResult$: { pipe: ReturnType<typeof vi.fn> };
  };
  let backendServiceMock: {
    activeBackend: ReturnType<typeof vi.fn>;
    isWindows: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    apiClientMock = {
      invoke: vi.fn(),
    };
    notificationServiceMock = {
      showError: vi.fn(),
      confirmModal: vi.fn(),
    };
    nautilusServiceMock = {
      newNautilusWindow: vi.fn().mockResolvedValue(undefined),
      openFilePicker: vi.fn(),
      filePickerResult$: { pipe: vi.fn() },
    };
    backendServiceMock = {
      activeBackend: vi.fn().mockReturnValue('Local'),
      isWindows: vi.fn().mockReturnValue(false),
    };

    TestBed.configureTestingModule({
      providers: [
        FileSystemService,
        PathService,
        { provide: ApiClientService, useValue: apiClientMock },
        { provide: NotificationService, useValue: notificationServiceMock },
        { provide: NautilusService, useValue: nautilusServiceMock },
        { provide: BackendService, useValue: backendServiceMock },
        { provide: TranslateService, useValue: { instant: (k: string): string => k } },
      ],
    });

    service = TestBed.inject(FileSystemService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('openInFiles', () => {
    it('should return immediately if path is empty', async () => {
      await service.openInFiles('');
      expect(apiClientMock.invoke).not.toHaveBeenCalled();
      expect(nautilusServiceMock.newNautilusWindow).not.toHaveBeenCalled();
    });

    describe('in Tauri mode', () => {
      beforeEach(() => {
        Object.defineProperty(service, 'isTauri', { value: true, configurable: true });
      });

      it('should invoke open_in_files for saf:// paths', async () => {
        apiClientMock.invoke.mockResolvedValueOnce('Opened');
        await service.openInFiles('saf://Dropbox');

        expect(apiClientMock.invoke).toHaveBeenCalledWith('open_in_files', {
          path: 'saf://Dropbox',
        });
      });

      it('should invoke open_in_files for local paths', async () => {
        apiClientMock.invoke.mockResolvedValueOnce('Opened');
        await service.openInFiles('/storage/emulated/0/Google Drive Sync');

        expect(apiClientMock.invoke).toHaveBeenCalledWith('open_in_files', {
          path: '/storage/emulated/0/Google Drive Sync',
        });
      });

      it('should route internal app paths on mobile to Nautilus window', async () => {
        vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
          'Mozilla/5.0 (Linux; Android 14; Pixel 8)'
        );

        await service.openInFiles('/data/user/0/com.rclone.manager/cache/rclone/vfs/Google Drive');

        expect(nautilusServiceMock.newNautilusWindow).toHaveBeenCalledWith(
          '/',
          'data/user/0/com.rclone.manager/cache/rclone/vfs/Google Drive'
        );
        expect(apiClientMock.invoke).not.toHaveBeenCalled();
      });

      it('should invoke open_in_files for desktop paths', async () => {
        apiClientMock.invoke.mockResolvedValueOnce('Opened');
        await service.openInFiles('/home/user/Documents');

        expect(apiClientMock.invoke).toHaveBeenCalledWith('open_in_files', {
          path: '/home/user/Documents',
        });
      });

      it('should route unmounted remote paths to Nautilus window', async () => {
        const pathService = TestBed.inject(PathService);
        pathService.setRemoteNames(['gdrive']);

        await service.openInFiles('gdrive:subfolder/test');

        expect(nautilusServiceMock.newNautilusWindow).toHaveBeenCalledWith(
          'gdrive',
          'subfolder/test'
        );
        expect(apiClientMock.invoke).not.toHaveBeenCalled();
      });

      it('should show error notification when invokeCommand fails', async () => {
        apiClientMock.invoke.mockRejectedValueOnce(new Error('Failed to open'));

        await expect(service.openInFiles('/home/user/Documents')).rejects.toThrow('Failed to open');
        expect(notificationServiceMock.showError).toHaveBeenCalled();
      });
    });

    describe('when in headless/web mode', () => {
      beforeEach(() => {
        Object.defineProperty(service, 'isTauri', { value: false, configurable: true });
      });

      it('should open Nautilus window', async () => {
        await service.openInFiles('/var/log/app');

        expect(nautilusServiceMock.newNautilusWindow).toHaveBeenCalledWith('/', 'var/log/app');
        expect(apiClientMock.invoke).not.toHaveBeenCalled();
      });
    });
  });
});
