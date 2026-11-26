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
import { RemoteManagementService } from '../remote/remote-management.service';
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
  const deleteItems = vi.fn();
  const getRemotePaths = vi.fn();
  const localPathInfo = vi.fn();
  const openTransferConflicts = vi.fn();
  const getFeatures = vi.fn();
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
    uploadLocalDropPaths.mockResolvedValue(42);
    transferItems.mockResolvedValue(7);
    deleteItems.mockResolvedValue(8);
    getRemotePaths.mockResolvedValue({ list: [] });
    getFeatures.mockResolvedValue({ CaseInsensitive: false });
    localPathInfo.mockImplementation(async (paths: string[]) =>
      paths.map(path => ({ name: path.split('/').pop(), isDir: path.endsWith('folder'), size: 4 }))
    );
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
            deleteItems,
            getRemotePaths,
            localPathInfo,
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
            getParentPath: (path: string): string => path.split('/').slice(0, -1).join('/'),
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
        { provide: ModalService, useValue: { openTransferOptions, openTransferConflicts } },
        { provide: AppSettingsService, useValue: { getSettingValue } },
        { provide: RemoteManagementService, useValue: { getFeatures } },
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
      undefined,
      {}
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
      undefined,
      {}
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
      chosen,
      {}
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
    translateBackendMessage.mockReturnValueOnce('');
    uploadLocalDropPaths.mockRejectedValueOnce(new Error(''));
    expect(await service.uploadLocalPaths(remote, '', ['/tmp/file'])).toBe(false);
    expect(notifications.showError.mock.calls).toEqual([
      ['translated:denied'],
      ['nautilus.errors.externalDropFailed'],
    ]);
  });

  describe('name conflicts', () => {
    const fileItem = (remoteName: string, path: string, isDir = false): FileBrowserItem =>
      ({
        entry: {
          Path: path,
          Name: path.split('/').pop(),
          IsDir: isDir,
          Size: 5,
          ModTime: '2026-11-25T10:00:00Z',
        },
        meta: { remote: remoteName },
      }) as unknown as FileBrowserItem;
    const answer = (choices: object | undefined): void => {
      openTransferConflicts.mockReturnValueOnce({ afterClosed: () => of(choices) });
    };

    it('asks about the names the destination holds and lands each item as chosen', async () => {
      getRemotePaths.mockResolvedValueOnce({
        list: [
          { Name: 'a.txt', IsDir: false, Size: 3, ModTime: '2026-11-01T00:00:00Z' },
          { Name: 'Photos', IsDir: true, Size: -1, ModTime: '' },
          { Name: 'c.txt', IsDir: false, Size: 1, ModTime: '' },
        ],
      });
      answer({
        'a.txt': { action: 'keepBoth', name: 'a (2).txt' },
        Photos: { action: 'replace', existingFiles: 'newer' },
        'c.txt': { action: 'skip' },
      });
      const items = [
        fileItem('nas', 'a.txt'),
        fileItem('nas', 'Photos', true),
        fileItem('nas', 'b.txt'),
        fileItem('nas', 'c.txt'),
      ];
      await service.performFileOperations(items, remote, 'target', 'copy');

      expect(getRemotePaths).toHaveBeenCalledExactlyOnceWith('drive:', 'target', {}, 'filemanager');
      const data = openTransferConflicts.mock.calls[0][0];
      expect(data).toMatchObject({ operation: 'copy', destination: 'drive:target', total: 4 });
      expect(data.conflicts.map((c: { incoming: { name: string } }) => c.incoming.name)).toEqual([
        'a.txt',
        'Photos',
        'c.txt',
      ]);
      expect(data.conflicts[0].existing).toEqual({
        name: 'a.txt',
        isDir: false,
        size: 3,
        modTime: '2026-11-01T00:00:00Z',
      });
      expect(data.taken).toEqual(expect.arrayContaining(['a.txt', 'Photos', 'c.txt', 'b.txt']));
      expect(transferItems.mock.calls[0][0]).toEqual([
        {
          remote: 'nas:',
          path: 'a.txt',
          name: 'a (2).txt',
          isDir: false,
          existingFiles: undefined,
        },
        { remote: 'nas:', path: 'Photos', name: 'Photos', isDir: true, existingFiles: 'newer' },
        { remote: 'nas:', path: 'b.txt', name: 'b.txt', isDir: false, existingFiles: undefined },
      ]);
      // A merge cannot be undone, and earlier entries may name what it replaced.
      expect(service.canUndo()).toBe(false);
    });

    it('compares names as the destination does, in any case where it ignores case', async () => {
      getRemotePaths.mockResolvedValue({
        list: [
          { Name: 'Report.PDF', IsDir: false },
          { Name: 'report (2).pdf', IsDir: false },
        ],
      });
      await service.performFileOperations([fileItem('nas', 'report.pdf')], remote, '', 'copy');
      expect(openTransferConflicts).not.toHaveBeenCalled();
      expect(getFeatures).toHaveBeenCalledWith('drive:', { source: 'filemanager' });

      getFeatures.mockResolvedValue({ CaseInsensitive: true });
      answer({ 'report.pdf': { action: 'skip' } });
      await service.performFileOperations([fileItem('nas', 'report.pdf')], remote, '', 'copy');
      const data = openTransferConflicts.mock.calls[0][0];
      expect(data.caseInsensitive).toBe(true);
      expect(data.conflicts[0].existing.name).toBe('Report.PDF');

      // A copy into its own folder avoids a name taken in another case.
      await service.performFileOperations([fileItem('drive', 'Report.PDF')], remote, '', 'copy');
      expect(transferItems.mock.calls[1][0][0].name).toBe('Report (3).PDF');
    });

    it('refuses a folder going into itself or a folder inside it, before asking anything', async () => {
      for (const destination of ['test/dfsgh', '/test/dfsgh/', 'test/dfsgh/sub']) {
        for (const mode of ['copy', 'move'] as const) {
          await service.performFileOperations(
            [fileItem('drive', 'test/dfsgh', true)],
            remote,
            destination,
            mode
          );
        }
      }
      expect(notifications.showError).toHaveBeenCalledTimes(6);
      expect(notifications.showError).toHaveBeenCalledWith('backendErrors.file.intoItself');
      expect(getRemotePaths).not.toHaveBeenCalled();
      expect(transferItems).not.toHaveBeenCalled();

      // Beside it, a folder whose name only starts the same, or another remote: allowed.
      await service.performFileOperations(
        [fileItem('drive', 'test/dfsgh', true)],
        remote,
        'test/dfsghx',
        'copy'
      );
      await service.performFileOperations(
        [fileItem('nas', 'test/dfsgh', true)],
        remote,
        'test/dfsgh',
        'copy'
      );
      expect(transferItems).toHaveBeenCalledTimes(2);
    });

    it('shows why rclone refused a copy, or a count when it gives no reason', async () => {
      transferItems.mockRejectedValueOnce(new Error('backendErrors.file.readOnly'));
      await service.performFileOperations([fileItem('nas', 'a.txt')], remote, '', 'copy');
      expect(notifications.showError).toHaveBeenCalledExactlyOnceWith(
        'translated:backendErrors.file.readOnly'
      );
    });

    it('starts nothing when the question is cancelled or every item is skipped', async () => {
      getRemotePaths.mockResolvedValue({ list: [{ Name: 'a.txt', IsDir: false }] });
      answer(undefined);
      await service.performFileOperations([fileItem('nas', 'a.txt')], remote, '', 'copy');
      answer({ 'a.txt': { action: 'skip' } });
      await service.performFileOperations([fileItem('nas', 'a.txt')], remote, '', 'move');
      expect(transferItems).not.toHaveBeenCalled();
      expect(notifications.showInfo).not.toHaveBeenCalled();
    });

    it('keeps a copy into its own folder beside the original without asking', async () => {
      getRemotePaths.mockResolvedValueOnce({
        list: [
          { Name: 'a.txt', IsDir: false },
          { Name: 'a (2).txt', IsDir: false },
        ],
      });
      await service.performFileOperations(
        [fileItem('drive', 'docs/a.txt')],
        remote,
        'docs',
        'copy'
      );
      expect(openTransferConflicts).not.toHaveBeenCalled();
      expect(transferItems.mock.calls[0][0][0].name).toBe('a (3).txt');
      expect(service.canUndo()).toBe(true);

      // Moving an item into the folder it is in changes nothing.
      await service.performFileOperations(
        [fileItem('drive', 'docs/a.txt')],
        remote,
        '/docs/',
        'move'
      );
      expect(transferItems).toHaveBeenCalledTimes(1);
    });

    it('leaves a destination it cannot list to rclone, as before', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      getRemotePaths.mockRejectedValueOnce(new Error('directory not found'));
      await service.performFileOperations([fileItem('nas', 'a.txt')], remote, 'new', 'copy');
      expect(openTransferConflicts).not.toHaveBeenCalled();
      expect(transferItems.mock.calls[0][0][0].name).toBe('a.txt');
    });

    it('undoes a kept copy under its new name and puts a moved one back under its own', async () => {
      getRemotePaths.mockResolvedValue({ list: [{ Name: 'a.txt', IsDir: false }] });
      answer({ 'a.txt': { action: 'keepBoth', name: 'a (2).txt' } });
      await service.performFileOperations([fileItem('nas', 'src/a.txt')], remote, 'dst', 'move');
      expect(service.canUndo()).toBe(true);

      await service.undoLastOperation();
      expect(transferItems.mock.calls[1].slice(0, 4)).toEqual([
        [{ remote: 'drive:', path: 'dst/a (2).txt', name: 'a.txt', isDir: false }],
        'nas:',
        'src',
        'move',
      ]);
      await service.redoLastOperation();
      expect(transferItems.mock.calls[2].slice(0, 4)).toEqual([
        [{ remote: 'nas:', path: 'src/a.txt', name: 'a (2).txt', isDir: false }],
        'drive:',
        'dst',
        'move',
      ]);
    });

    it('asks about picked local paths and sends only those not skipped, with their targets', async () => {
      getRemotePaths.mockResolvedValueOnce({
        list: [
          { Name: 'file', IsDir: false },
          { Name: 'folder', IsDir: true },
        ],
      });
      answer({
        file: { action: 'skip' },
        folder: { action: 'replace', existingFiles: 'keep' },
      });
      expect(await service.uploadLocalPaths(remote, 'target', ['/tmp/file', '/tmp/folder'])).toBe(
        true
      );
      expect(localPathInfo).toHaveBeenCalledExactlyOnceWith(['/tmp/file', '/tmp/folder']);
      expect(openTransferConflicts.mock.calls[0][0]).toMatchObject({
        operation: 'upload',
        total: 2,
      });
      expect(uploadLocalDropPaths).toHaveBeenCalledExactlyOnceWith(
        'drive:',
        'target',
        ['/tmp/folder'],
        'filemanager',
        undefined,
        undefined,
        { folder: { name: undefined, existingFiles: 'keep' } }
      );
    });

    it('compares what a browser upload brings to the destination folder by its first name', async () => {
      getRemotePaths.mockResolvedValue({
        list: [
          { Name: 'folder', IsDir: true },
          { Name: 'photo.jpg', IsDir: false },
        ],
      });
      const photo = new File(['12345'], 'photo.jpg', { lastModified: Date.UTC(2026, 10, 25) });
      const upload = [...entries, { file: photo, relativePath: 'photo.jpg' }];
      answer({
        folder: { action: 'skip' },
        'photo.jpg': { action: 'keepBoth', name: 'photo (2).jpg' },
      });
      expect(await service.uploadWebEntries(remote, 'target', upload, ['folder/empty'])).toBe(true);
      const { conflicts } = openTransferConflicts.mock.calls[0][0];
      expect(conflicts.map((c: { incoming: object }) => c.incoming)).toEqual([
        { name: 'folder', isDir: true },
        { name: 'photo.jpg', isDir: false, size: 5, modTime: '2026-11-25T00:00:00.000Z' },
      ]);
      expect(uploadWebFilesBatch).toHaveBeenCalledExactlyOnceWith(
        'drive:',
        'target',
        [{ file: photo, relativePath: 'photo.jpg' }],
        'filemanager',
        [],
        undefined,
        { 'photo.jpg': { name: 'photo (2).jpg', existingFiles: undefined } }
      );

      answer({ folder: { action: 'skip' }, 'photo.jpg': { action: 'skip' } });
      expect(await service.uploadWebEntries(remote, 'target', upload)).toBe(false);
      expect(uploadWebFilesBatch).toHaveBeenCalledTimes(1);
    });
  });
});
