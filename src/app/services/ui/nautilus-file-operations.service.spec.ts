import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExplorerRoot } from '@app/types';
import { NautilusFileOperationsService } from './nautilus-file-operations.service';
import { RemoteFileOperationsService } from '../remote/remote-file-operations.service';
import { FileSystemService } from '../operations/file-system.service';
import { PathService } from '../infrastructure/platform/path.service';
import { ModalService } from './modal.service';
import { NotificationService } from './notification.service';
import { BackendTranslationService } from '../i18n/backend-translation.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { of } from 'rxjs';
import { FileBrowserItem } from '@app/types';

const remote: ExplorerRoot = { name: 'drive', label: 'Drive', isLocal: false, type: 'drive' };
const entries = [{ file: new File(['data'], 'file.txt'), relativePath: 'folder/file.txt' }];

describe('Nautilus shared upload operations', () => {
  let service: NautilusFileOperationsService;
  const makeDirectory = vi.fn();
  const uploadWebFilesBatch = vi.fn();
  const uploadLocalDropPaths = vi.fn();
  const pendingWebUploads = vi.fn(() => [] as object[]);
  const attachWebUploadFiles = vi.fn();
  const resumeWebUpload = vi.fn();
  const releaseUploadPaths = vi.fn();
  const translateBackendMessage = vi.fn((error: Error) => `translated:${error.message}`);
  const transferItems = vi.fn();
  const settings: Record<string, unknown> = {};
  const getSettingValue = vi.fn(async (key: string) => settings[key]);
  const openTransferOptions = vi.fn();
  const notifications = {
    showError: vi.fn(),
    showWarning: vi.fn(),
    showSuccess: vi.fn(),
    showInfo: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    makeDirectory.mockResolvedValue(undefined);
    uploadWebFilesBatch.mockResolvedValue('finished');
    uploadLocalDropPaths.mockResolvedValue('42');
    transferItems.mockResolvedValue('7');
    for (const key of Object.keys(settings)) delete settings[key];
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    TestBed.configureTestingModule({
      providers: [
        NautilusFileOperationsService,
        {
          provide: RemoteFileOperationsService,
          useValue: {
            makeDirectory,
            uploadWebFilesBatch,
            uploadLocalDropPaths,
            transferItems,
            pendingWebUploads,
            attachWebUploadFiles,
            resumeWebUpload,
          },
        },
        {
          provide: PathService,
          useValue: {
            normalizeExplorerRoot: (root: ExplorerRoot): string => `${root.name}:`,
            normalizeRemoteForRclone: (name: string): string => (name ? `${name}:` : ''),
            joinPath: (...parts: string[]): string => parts.filter(Boolean).join('/'),
          },
        },
        {
          provide: FileSystemService,
          useValue: {
            selectFilesForUpload: vi.fn().mockResolvedValue(['/tmp/file']),
            selectFolderForUpload: vi.fn().mockResolvedValue('/tmp/folder'),
            releaseUploadPaths,
          },
        },
        { provide: ModalService, useValue: { openTransferOptions } },
        { provide: AppSettingsService, useValue: { getSettingValue } },
        { provide: BackendTranslationService, useValue: { translateBackendMessage } },
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
    const app = window as Window & { __TAURI_INTERNALS__?: unknown };
    app.__TAURI_INTERNALS__ = {};
    try {
      await service.pasteSystemClipboard(remote, 'target', '/tmp/file');
    } finally {
      delete app.__TAURI_INTERNALS__;
    }
    await service.uploadExternalFiles(remote, 'target');
    await service.uploadExternalFolder(remote, 'target');
    expect(upload.mock.calls).toEqual([
      [remote, 'target', ['/tmp/file']],
      [remote, 'target', ['/tmp/file']],
      [remote, 'target', ['/tmp/folder']],
    ]);
    // Picked copies are removed once their upload ended.
    expect(releaseUploadPaths.mock.calls).toEqual([[['/tmp/file']], [['/tmp/folder']]]);
    expect(notifications.showError).not.toHaveBeenCalled();
  });

  it("does not upload clipboard paths in a browser, where they name the browser's files", async () => {
    const upload = vi.spyOn(service, 'uploadLocalPaths').mockResolvedValue(true);
    const readText = vi.fn().mockResolvedValue('/home/user/file.txt');
    vi.stubGlobal('navigator', { clipboard: { readText } });
    try {
      expect(await service.pasteSystemClipboard(remote, 'target', '/home/user/file.txt')).toBe(
        false
      );
      expect(await service.checkSystemClipboard()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(upload).not.toHaveBeenCalled();
    // Reading the clipboard would ask the browser for a permission that serves nothing.
    expect(readText).not.toHaveBeenCalled();
    expect(service.systemClipboardHasPaths()).toBe(false);
  });

  it('passes explicit empty directories and files together into one upload', async () => {
    expect(await service.uploadWebEntries(remote, 'target', entries, ['empty', 'empty'])).toBe(
      true
    );
    expect(makeDirectory).not.toHaveBeenCalled();
    expect(uploadWebFilesBatch).toHaveBeenCalledExactlyOnceWith(
      'drive:',
      'target',
      entries,
      'filemanager',
      ['empty', 'empty'],
      undefined
    );
    expect(notifications.showSuccess).toHaveBeenCalledExactlyOnceWith(
      'nautilus.notifications.uploadSuccess'
    );
  });

  it('reports success only for a finished transfer with files', async () => {
    expect(await service.uploadWebEntries(remote, '', [], ['empty'])).toBe(true);
    uploadWebFilesBatch.mockResolvedValueOnce('running');
    expect(await service.uploadWebEntries(remote, '', entries)).toBe(true);
    uploadWebFilesBatch.mockResolvedValueOnce('cancelled');
    expect(await service.uploadWebEntries(remote, '', entries)).toBe(false);
    expect(notifications.showSuccess).not.toHaveBeenCalled();
    expect(notifications.showError).not.toHaveBeenCalled();

    expect(await service.uploadWebEntries(remote, '', [])).toBe(false);
  });

  it('shows the server error of a failed upload, or a count when it has none', async () => {
    uploadWebFilesBatch.mockRejectedValueOnce(new Error('backendErrors.file.diskFull'));
    expect(await service.uploadWebEntries(remote, '', entries)).toBe(false);
    translateBackendMessage.mockReturnValueOnce('');
    uploadWebFilesBatch.mockRejectedValueOnce(new Error(''));
    expect(await service.uploadWebEntries(remote, '', entries)).toBe(false);
    expect(notifications.showError.mock.calls).toEqual([
      ['translated:backendErrors.file.diskFull'],
      ['nautilus.notifications.uploadFailed'],
    ]);
  });

  it('says where to continue an upload that lost its connection', async () => {
    uploadWebFilesBatch.mockResolvedValueOnce('paused');
    expect(await service.uploadWebEntries(remote, 'target', entries)).toBe(false);
    expect(notifications.showWarning).toHaveBeenCalledExactlyOnceWith(
      'nautilus.notifications.uploadInterrupted'
    );
    expect(notifications.showSuccess).not.toHaveBeenCalled();
  });

  it('continues a paused upload with the files selected again and reports what is missing', async () => {
    const paused = { group: 'upload-1', files: 3, paused: { missing: 2 } };
    pendingWebUploads.mockReturnValue([paused]);
    attachWebUploadFiles.mockReturnValueOnce(0);
    expect(await service.resumeWebUpload('upload-1', entries)).toBe(false);
    expect(notifications.showError).toHaveBeenCalledExactlyOnceWith(
      'nautilus.notifications.uploadFilesNotInUpload'
    );
    expect(resumeWebUpload).not.toHaveBeenCalled();

    attachWebUploadFiles.mockReturnValueOnce(1);
    resumeWebUpload.mockResolvedValueOnce('paused');
    pendingWebUploads.mockReturnValue([{ ...paused, paused: { missing: 1 } }]);
    expect(await service.resumeWebUpload('upload-1', entries)).toBe(false);
    expect(attachWebUploadFiles).toHaveBeenLastCalledWith('upload-1', entries);
    expect(notifications.showWarning).toHaveBeenCalledExactlyOnceWith(
      'nautilus.notifications.uploadFilesStillMissing'
    );

    resumeWebUpload.mockResolvedValueOnce('finished');
    expect(await service.resumeWebUpload('upload-1')).toBe(true);
    expect(notifications.showSuccess).toHaveBeenCalledExactlyOnceWith(
      'nautilus.notifications.uploadSuccess'
    );
  });

  it('leaves the default options to the backend unless the preferences ask each time', async () => {
    await service.uploadLocalPaths(remote, 'target', ['/tmp/file']);
    expect(openTransferOptions).not.toHaveBeenCalled();
    expect(uploadLocalDropPaths).toHaveBeenCalledWith(
      'drive:',
      'target',
      ['/tmp/file'],
      'filemanager',
      undefined,
      undefined
    );
  });

  it('asks for the options, passes them on, and starts nothing when cancelled', async () => {
    const defaults = { copy: { check_first: true } };
    const chosen = { copy: { checksum: true }, remotes: { drive: { chunk_size: '64M' } } };
    settings['nautilus.ask_transfer_options'] = true;
    settings['nautilus.transfer_options'] = defaults;
    openTransferOptions.mockReturnValueOnce({ afterClosed: () => of(chosen) });
    expect(await service.uploadWebEntries(remote, 'target', entries)).toBe(true);
    expect(openTransferOptions).toHaveBeenCalledExactlyOnceWith({
      mode: 'transfer',
      operation: 'upload',
      count: 1,
      destination: 'drive:target',
      remotes: ['drive'],
      values: defaults,
    });
    expect(uploadWebFilesBatch).toHaveBeenCalledWith(
      'drive:',
      'target',
      entries,
      'filemanager',
      [],
      chosen
    );

    openTransferOptions.mockReturnValueOnce({ afterClosed: () => of(undefined) });
    expect(await service.uploadLocalPaths(remote, 'target', ['/tmp/file'])).toBe(false);
    expect(uploadLocalDropPaths).not.toHaveBeenCalled();
  });

  it('asks only for copies and moves that leave their remote, naming every remote they touch', async () => {
    settings['nautilus.ask_transfer_options'] = true;
    openTransferOptions.mockReturnValue({ afterClosed: () => of({}) });
    const item = (remoteName: string): FileBrowserItem =>
      ({
        entry: { Path: 'a.txt', Name: 'a.txt', IsDir: false },
        meta: { remote: remoteName },
      }) as unknown as FileBrowserItem;

    await service.performFileOperations([item('drive')], remote, 'other', 'move');
    expect(openTransferOptions).not.toHaveBeenCalled();
    expect(transferItems.mock.calls[0][7]).toBeUndefined();

    await service.performFileOperations([item('nas'), item('nas'), item('')], remote, '', 'copy');
    expect(openTransferOptions).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        operation: 'copy',
        count: 3,
        destination: 'drive:',
        remotes: ['drive', 'nas'],
        values: {},
      })
    );
    expect(transferItems.mock.calls[1][7]).toEqual({});
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
});
