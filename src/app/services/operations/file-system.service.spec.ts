import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { FileSystemService } from './file-system.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { NotificationService } from '../ui/notification.service';
import { NautilusService } from '../ui/nautilus.service';
import { BackendService } from '../infrastructure/system/backend.service';
import { PathService } from '../infrastructure/platform/path.service';
import { FilePickerResult } from '@app/types';

describe('FileSystemService', () => {
  let service: FileSystemService;
  let apiClientMock: {
    invoke: ReturnType<typeof vi.fn>;
  };
  let notificationServiceMock: {
    showError: ReturnType<typeof vi.fn>;
    showInfo: ReturnType<typeof vi.fn>;
    confirmModal: ReturnType<typeof vi.fn>;
  };
  let nautilusServiceMock: {
    newNautilusWindow: ReturnType<typeof vi.fn>;
    openFilePicker: ReturnType<typeof vi.fn>;
    filePickerResult$: { pipe: ReturnType<typeof vi.fn> };
  };
  let backendServiceMock: {
    activeBackend: ReturnType<typeof vi.fn>;
    isLocalBackend: ReturnType<typeof vi.fn>;
    isWindows: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    apiClientMock = {
      invoke: vi.fn(),
    };
    notificationServiceMock = {
      showError: vi.fn(),
      showInfo: vi.fn(),
      confirmModal: vi.fn(),
    };
    nautilusServiceMock = {
      newNautilusWindow: vi.fn().mockResolvedValue(undefined),
      openFilePicker: vi.fn(),
      filePickerResult$: { pipe: vi.fn() },
    };
    backendServiceMock = {
      activeBackend: vi.fn().mockReturnValue('Local'),
      isLocalBackend: vi.fn().mockReturnValue(true),
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

  describe('upload pickers', () => {
    const picked = (paths: string[], cancelled = false): FilePickerResult => ({
      paths,
      items: [],
      cancelled,
    });

    it('use the native dialogs on the desktop even with a remote engine', async () => {
      Object.defineProperty(service, 'isTauri', { value: true, configurable: true });
      backendServiceMock.activeBackend.mockReturnValue('NAS');
      const nautilus = vi.spyOn(service, 'selectPathWithNautilus');
      apiClientMock.invoke.mockResolvedValueOnce(['/home/me/a.txt']).mockResolvedValueOnce(null);

      expect(await service.selectFilesForUpload()).toEqual(['/home/me/a.txt']);
      expect(await service.selectFolderForUpload()).toBeNull();
      expect(apiClientMock.invoke.mock.calls.map(call => call[0])).toEqual([
        'get_files_location',
        'get_folder_location',
      ]);
      expect(nautilus).not.toHaveBeenCalled();
    });

    it('use the local file browser in a browser and return null when it is cancelled', async () => {
      Object.defineProperty(service, 'isTauri', { value: false, configurable: true });
      const nautilus = vi
        .spyOn(service, 'selectPathWithNautilus')
        .mockResolvedValueOnce(picked(['/storage/emulated/0/DCIM']))
        .mockResolvedValueOnce(picked([], true));

      expect(await service.selectFolderForUpload()).toBe('/storage/emulated/0/DCIM');
      expect(await service.selectFolderForUpload()).toBeNull();
      expect(nautilus).toHaveBeenCalledWith({ mode: 'local', selection: 'folders', multi: false });
      expect(apiClientMock.invoke).not.toHaveBeenCalled();
    });

    describe('on Android', () => {
      const app = window as Window & { __rclone__?: object };
      const pickUploadFiles = vi.fn();
      const clearSharedFiles = vi.fn();
      const answer = (detail: object): void => {
        window.dispatchEvent(new CustomEvent('android-upload-picked', { detail }));
      };

      beforeEach(() => {
        Object.defineProperty(service, 'isTauri', { value: true, configurable: true });
        vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
          'Mozilla/5.0 (Linux; Android 14; Pixel 8)'
        );
        pickUploadFiles.mockReset().mockReturnValue(true);
        clearSharedFiles.mockReset();
        app.__rclone__ = { pickUploadFiles, clearSharedFiles };
      });

      afterEach(() => delete app.__rclone__);

      it.each([true, false])(
        'picks with the Android picker whether the engine is on the phone (%s) or not',
        async local => {
          backendServiceMock.isLocalBackend.mockReturnValue(local);
          const nautilus = vi.spyOn(service, 'selectPathWithNautilus');
          const files = service.selectFilesForUpload();
          answer({ stage: 'done', paths: ['/cache/shared_files/a.jpg'], failed: 0 });
          expect(await files).toEqual(['/cache/shared_files/a.jpg']);
          expect(nautilus).not.toHaveBeenCalled();
        }
      );

      it('tells what it copies and what it could not read', async () => {
        const nautilus = vi.spyOn(service, 'selectPathWithNautilus');
        const files = service.selectFilesForUpload();
        expect(pickUploadFiles).toHaveBeenCalledExactlyOnceWith(false);
        answer({ stage: 'copying', count: 2 });
        expect(notificationServiceMock.showInfo).toHaveBeenCalledExactlyOnceWith(
          'nautilus.notifications.copyingPickedFiles'
        );
        answer({ stage: 'done', paths: ['/cache/shared_files/a.jpg'], failed: 1 });
        expect(await files).toEqual(['/cache/shared_files/a.jpg']);
        expect(notificationServiceMock.showError).toHaveBeenCalledExactlyOnceWith(
          'nautilus.notifications.pickedFilesNotCopied'
        );

        const folder = service.selectFolderForUpload();
        expect(pickUploadFiles).toHaveBeenLastCalledWith(true);
        answer({ stage: 'done', paths: [], failed: 0 });
        expect(await folder).toBeNull();
        expect(nautilus).not.toHaveBeenCalled();
      });

      it('hands the copies back to the app once their upload ended', () => {
        service.releaseUploadPaths(['/cache/shared_files/a.jpg']);
        expect(clearSharedFiles).toHaveBeenCalledExactlyOnceWith('["/cache/shared_files/a.jpg"]');
        // Elsewhere nothing is a copy, and nothing is removed.
        Object.defineProperty(service, 'isTauri', { value: false, configurable: true });
        service.releaseUploadPaths(['/home/me/a.jpg']);
        expect(clearSharedFiles).toHaveBeenCalledOnce();
      });

      it('selects nothing while another picker is open', async () => {
        pickUploadFiles.mockReturnValue(false);
        expect(await service.selectFilesForUpload()).toEqual([]);
      });
    });
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

    describe('with a remote engine on the desktop', () => {
      beforeEach(() => {
        Object.defineProperty(service, 'isTauri', { value: true, configurable: true });
        backendServiceMock.activeBackend.mockReturnValue('NAS');
      });

      it('should open the path in Nautilus instead of the system file manager', async () => {
        await service.openInFiles('/mnt/media');

        expect(nautilusServiceMock.newNautilusWindow).toHaveBeenCalledWith('/', 'mnt/media');
        expect(apiClientMock.invoke).not.toHaveBeenCalled();
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
