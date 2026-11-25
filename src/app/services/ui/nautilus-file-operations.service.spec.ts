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
  const translateBackendMessage = vi.fn((error: Error) => `translated:${error.message}`);
  const transferItems = vi.fn();
  const settings: Record<string, unknown> = {};
  const getSettingValue = vi.fn(async (key: string) => settings[key]);
  const openTransferTemplate = vi.fn();
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
          useValue: { makeDirectory, uploadWebFilesBatch, uploadLocalDropPaths, transferItems },
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
          },
        },
        { provide: ModalService, useValue: { openTransferTemplate } },
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
    await service.pasteSystemClipboard(remote, 'target', '/tmp/file');
    await service.uploadExternalFiles(remote, 'target');
    await service.uploadExternalFolder(remote, 'target');
    expect(upload.mock.calls).toEqual([
      [remote, 'target', ['/tmp/file']],
      [remote, 'target', ['/tmp/file']],
      [remote, 'target', ['/tmp/folder']],
    ]);
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

  it('leaves the default template to the backend unless the preferences ask each time', async () => {
    await service.uploadLocalPaths(remote, 'target', ['/tmp/file']);
    expect(openTransferTemplate).not.toHaveBeenCalled();
    expect(uploadLocalDropPaths).toHaveBeenCalledWith(
      'drive:',
      'target',
      ['/tmp/file'],
      'filemanager',
      undefined,
      undefined
    );
  });

  it('asks for the template, passes the choice on, and starts nothing when cancelled', async () => {
    settings['file_browser.ask_transfer_template'] = true;
    settings['file_browser.transfer_template'] = 'usr-tpl-default';
    openTransferTemplate.mockReturnValueOnce({ afterClosed: () => of('usr-tpl-1') });
    expect(await service.uploadWebEntries(remote, 'target', entries)).toBe(true);
    expect(openTransferTemplate).toHaveBeenCalledExactlyOnceWith({
      selected: 'usr-tpl-default',
      operation: 'upload',
      count: 1,
      destination: 'drive:target',
    });
    expect(uploadWebFilesBatch).toHaveBeenCalledWith(
      'drive:',
      'target',
      entries,
      'filemanager',
      [],
      'usr-tpl-1'
    );

    openTransferTemplate.mockReturnValueOnce({ afterClosed: () => of(undefined) });
    expect(await service.uploadLocalPaths(remote, 'target', ['/tmp/file'])).toBe(false);
    expect(uploadLocalDropPaths).not.toHaveBeenCalled();
  });

  it('asks only for copies and moves that leave their remote', async () => {
    settings['file_browser.ask_transfer_template'] = true;
    openTransferTemplate.mockReturnValue({ afterClosed: () => of('') });
    const item = (remoteName: string): FileBrowserItem =>
      ({
        entry: { Path: 'a.txt', Name: 'a.txt', IsDir: false },
        meta: { remote: remoteName },
      }) as unknown as FileBrowserItem;

    await service.performFileOperations([item('drive')], remote, 'other', 'move');
    expect(openTransferTemplate).not.toHaveBeenCalled();
    expect(transferItems.mock.calls[0][7]).toBeUndefined();

    await service.performFileOperations([item('nas')], remote, '', 'copy');
    expect(openTransferTemplate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ operation: 'copy', count: 1, destination: 'drive:' })
    );
    expect(transferItems.mock.calls[1][7]).toBe('');
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
