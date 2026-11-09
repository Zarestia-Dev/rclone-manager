import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExplorerRoot } from '@app/types';
import { NautilusFileOperationsService } from './nautilus-file-operations.service';
import { RemoteFileOperationsService } from '../remote/remote-file-operations.service';
import { FileSystemService } from '../operations/file-system.service';
import { PathService } from '../infrastructure/platform/path.service';
import { RcConsoleService } from '../infrastructure/system/rc-console.service';
import { ModalService } from './modal.service';
import { NotificationService } from './notification.service';

const remote: ExplorerRoot = { name: 'drive', label: 'Drive', isLocal: false, type: 'drive' };
const entries = [{ file: new File(['data'], 'file.txt'), relativePath: 'folder/file.txt' }];

describe('Nautilus shared upload operations', () => {
  let service: NautilusFileOperationsService;
  const makeDirectory = vi.fn();
  const uploadWebFilesBatch = vi.fn();
  const uploadLocalDropPaths = vi.fn();
  const generateIndex = vi.fn();
  const loadCommands = vi.fn();
  const openIndexCreate = vi.fn();
  const notifications = {
    showError: vi.fn(),
    showWarning: vi.fn(),
    showSuccess: vi.fn(),
    showInfo: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    makeDirectory.mockResolvedValue(undefined);
    uploadWebFilesBatch.mockResolvedValue({ successCount: 1, failedPaths: [] });
    uploadLocalDropPaths.mockResolvedValue('42');
    generateIndex.mockResolvedValue(undefined);
    loadCommands.mockResolvedValue([{ Path: 'operations/index' }]);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    TestBed.configureTestingModule({
      providers: [
        NautilusFileOperationsService,
        {
          provide: RemoteFileOperationsService,
          useValue: { makeDirectory, uploadWebFilesBatch, uploadLocalDropPaths, generateIndex },
        },
        {
          provide: PathService,
          useValue: {
            normalizeExplorerRoot: (root: ExplorerRoot): string => `${root.name}:`,
            joinPath: (...parts: string[]): string => parts.filter(Boolean).join('/'),
          },
        },
        {
          provide: FileSystemService,
          useValue: {
            selectFilesForUpload: vi.fn().mockResolvedValue(['/tmp/file']),
            selectFolder: vi.fn().mockResolvedValue('/tmp/folder'),
          },
        },
        { provide: ModalService, useValue: { openIndexCreate } },
        { provide: RcConsoleService, useValue: { loadCommands } },
        { provide: NotificationService, useValue: notifications },
        { provide: TranslateService, useValue: { instant: (key: string): string => key } },
      ],
    });
    service = TestBed.inject(NautilusFileOperationsService);
  });

  afterEach(() => vi.restoreAllMocks());

  it('routes the browser picker through the same operation as external drops', async () => {
    const upload = vi.spyOn(service, 'uploadWebEntries').mockResolvedValueOnce(true);
    const file = new File(['data'], 'file.txt');
    Object.defineProperty(file, 'webkitRelativePath', { value: 'folder/file.txt' });
    await service.uploadWebFiles(remote, 'target', [file] as unknown as FileList);
    expect(upload).toHaveBeenCalledExactlyOnceWith(remote, 'target', [
      { file, relativePath: 'folder/file.txt' },
    ]);
  });

  it('routes clipboard and native pickers through the same local upload', async () => {
    const upload = vi.spyOn(service, 'uploadLocalPaths').mockResolvedValue(true);
    await service.pasteSystemClipboard(remote, 'target', '/tmp/file');
    await service.uploadExternalFiles(remote, 'target');
    await service.uploadExternalFolder(remote, 'target');
    expect(upload.mock.calls).toEqual([
      [remote, 'target', ['/tmp/file']],
      [remote, 'target', ['/tmp/file']],
      [remote, 'target', ['/tmp/folder']],
    ]);
  });

  it('passes explicit empty directories and files together into batch upload without extra mkdir calls', async () => {
    expect(await service.uploadWebEntries(remote, 'target', entries, ['empty', 'empty'])).toBe(
      true
    );
    expect(makeDirectory).not.toHaveBeenCalled();
    expect(uploadWebFilesBatch).toHaveBeenCalledExactlyOnceWith(
      'drive:',
      'target',
      entries,
      'filemanager',
      ['empty', 'empty']
    );
    expect(notifications.showSuccess).toHaveBeenCalledOnce();
  });

  it('handles directory-only and empty inputs without reporting a zero-file upload', async () => {
    uploadWebFilesBatch.mockResolvedValueOnce({ successCount: 0, failedPaths: [] });
    expect(await service.uploadWebEntries(remote, '', [], ['empty'])).toBe(true);
    expect(uploadWebFilesBatch).toHaveBeenCalledExactlyOnceWith('drive:', '', [], 'filemanager', [
      'empty',
    ]);
    expect(notifications.showSuccess).not.toHaveBeenCalled();

    expect(await service.uploadWebEntries(remote, '', [])).toBe(false);
  });

  it('reports batch errors when upload fails', async () => {
    uploadWebFilesBatch.mockResolvedValueOnce({ successCount: 0, failedPaths: ['empty'] });
    expect(await service.uploadWebEntries(remote, '', [], ['empty'])).toBe(false);
    expect(notifications.showError).toHaveBeenCalledWith('nautilus.notifications.uploadFailed');
  });

  it('reports partial file failures identically for all browser upload entry points', async () => {
    uploadWebFilesBatch.mockResolvedValueOnce({ successCount: 1, failedPaths: ['failed'] });
    expect(await service.uploadWebEntries(remote, '', entries)).toBe(true);
    expect(notifications.showWarning).toHaveBeenCalledWith('nautilus.notifications.uploadFailed');
    expect(notifications.showSuccess).not.toHaveBeenCalled();
  });

  it('reports local upload errors once and skips empty inputs', async () => {
    expect(await service.uploadLocalPaths(remote, '', [])).toBe(false);
    expect(uploadLocalDropPaths).not.toHaveBeenCalled();
    uploadLocalDropPaths.mockRejectedValueOnce(new Error('denied'));
    expect(await service.uploadLocalPaths(remote, '', ['/tmp/file'])).toBe(false);
    expect(notifications.showError).toHaveBeenCalledExactlyOnceWith(
      'nautilus.errors.externalDropFailed'
    );
  });

  describe('openIndexDialog', () => {
    const request = { opt: { output: ['index.html=html'], maxDepth: -1 }, useServerModTime: true };

    it('writes the listings of the current folder with what the dialog returned', async () => {
      openIndexCreate.mockReturnValue({ afterClosed: () => of(request) });

      expect(await service.openIndexDialog(remote, 'site')).toBe(true);

      expect(openIndexCreate).toHaveBeenCalledExactlyOnceWith({ target: 'drive:/site' });
      expect(generateIndex).toHaveBeenCalledExactlyOnceWith(
        'drive:',
        'site',
        request.opt,
        true,
        'filemanager'
      );
      expect(notifications.showInfo).toHaveBeenCalledWith('nautilus.notifications.indexStarted');
    });

    it('does nothing when the dialog is dismissed', async () => {
      openIndexCreate.mockReturnValue({ afterClosed: () => of(undefined) });

      expect(await service.openIndexDialog(remote, 'site')).toBe(false);

      expect(generateIndex).not.toHaveBeenCalled();
    });

    it('says so, without asking anything, when rclone has no operations/index', async () => {
      loadCommands.mockResolvedValue([{ Path: 'operations/list' }]);

      expect(await service.openIndexDialog(remote, 'site')).toBe(false);

      expect(loadCommands).toHaveBeenLastCalledWith(true);

      expect(openIndexCreate).not.toHaveBeenCalled();
      expect(notifications.showError).toHaveBeenCalledExactlyOnceWith(
        'nautilus.errors.indexUnsupported'
      );
    });

    it('asks again when the cached command list is from an rclone that was updated since', async () => {
      loadCommands
        .mockResolvedValueOnce([{ Path: 'operations/list' }])
        .mockResolvedValueOnce([{ Path: 'operations/index' }]);
      openIndexCreate.mockReturnValue({ afterClosed: () => of(request) });

      expect(await service.openIndexDialog(remote, 'site')).toBe(true);

      expect(loadCommands.mock.calls).toEqual([[], [true]]);
      expect(notifications.showError).not.toHaveBeenCalled();
    });

    it('lets rclone answer when its command list cannot be read', async () => {
      loadCommands.mockResolvedValue([]);
      openIndexCreate.mockReturnValue({ afterClosed: () => of(request) });

      expect(await service.openIndexDialog(remote, '')).toBe(true);

      expect(generateIndex).toHaveBeenCalledOnce();
    });

    it('reports a failed run once and keeps the listing view as it was', async () => {
      openIndexCreate.mockReturnValue({ afterClosed: () => of(request) });
      generateIndex.mockRejectedValueOnce(new Error('denied'));

      expect(await service.openIndexDialog(remote, 'site')).toBe(false);

      expect(notifications.showError).toHaveBeenCalledExactlyOnceWith(
        'nautilus.errors.indexFailed'
      );
    });
  });
});
