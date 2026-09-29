import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExplorerRoot } from '@app/types';
import { DragDropCallbacks, NautilusDragDropService } from './nautilus-drag-drop.service';
import { RemoteFileOperationsService } from '../remote/remote-file-operations.service';
import { PathService } from '../infrastructure/platform/path.service';
import { NotificationService } from './notification.service';
import { NautilusFileOperationsService } from './nautilus-file-operations.service';
import { NautilusService } from './nautilus.service';
import { ModalService } from './modal.service';
import { FileSystemService } from '../operations/file-system.service';

function file(name: string): FileSystemEntry {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (success: (value: File) => void): void => success(new File(['content'], name)),
  } as unknown as FileSystemEntry;
}

function directory(name: string, batches: FileSystemEntry[][] = [], fail = false): FileSystemEntry {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: (): object => {
      let index = 0;
      return {
        readEntries: (
          success: (entries: FileSystemEntry[]) => void,
          error: (error: DOMException) => void
        ): void => {
          if (fail) error(new DOMException('Access denied', 'NotReadableError'));
          else success(batches[index++] ?? []);
        },
      };
    },
  } as unknown as FileSystemEntry;
}

function drop(entries: FileSystemEntry[]): DragEvent {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: {
      files: [],
      items: entries.map(entry => ({
        kind: 'file',
        webkitGetAsEntry: (): FileSystemEntry => entry,
      })),
    },
  } as unknown as DragEvent;
}

const remote: ExplorerRoot = { name: 'drive', label: 'Drive', isLocal: false, type: 'drive' };

describe('Nautilus external folder drops', () => {
  let service: NautilusDragDropService;
  const makeDirectory = vi.fn();
  const uploadWebFilesBatch = vi.fn();
  const refresh = vi.fn();
  const showError = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    makeDirectory.mockResolvedValue(undefined);
    uploadWebFilesBatch.mockResolvedValue({ successCount: 1, failedPaths: [] });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    TestBed.configureTestingModule({
      providers: [
        NautilusDragDropService,
        { provide: RemoteFileOperationsService, useValue: { makeDirectory, uploadWebFilesBatch } },
        {
          provide: PathService,
          useValue: {
            normalizeExplorerRoot: (root: ExplorerRoot): string => `${root.name}:`,
            joinPath: (...segments: string[]): string => segments.filter(Boolean).join('/'),
          },
        },
        {
          provide: NotificationService,
          useValue: { showError, showSuccess: vi.fn(), showWarning: vi.fn() },
        },
        { provide: TranslateService, useValue: { instant: (key: string): string => key } },
        NautilusFileOperationsService,
        { provide: ModalService, useValue: {} },
        { provide: FileSystemService, useValue: {} },
        { provide: NautilusService, useValue: {} },
      ],
    });
    service = TestBed.inject(NautilusDragDropService);
    service.register({ refresh } as unknown as DragDropCallbacks);
  });

  afterEach(() => vi.restoreAllMocks());

  it('uploads populated directory trees without issuing mkdir jobs', async () => {
    const tree = directory('folder', [[directory('nested', [[file('a.txt')]]), file('b.txt')]]);
    await service.dropToRemote(drop([tree]), remote);
    expect(makeDirectory).not.toHaveBeenCalled();
    expect(uploadWebFilesBatch).toHaveBeenCalledOnce();
    expect(
      uploadWebFilesBatch.mock.calls[0][2].map(
        (item: { relativePath: string }) => item.relativePath
      )
    ).toEqual(['folder/nested/a.txt', 'folder/b.txt']);
    expect(refresh).toHaveBeenCalledWith('drive', '');
  });

  it('preserves only empty leaves instead of mkdir for every ancestor', async () => {
    const tree = directory('folder', [
      [directory('empty-parent', [[directory('leaf')]]), file('a.txt')],
    ]);
    await service.dropToRemote(drop([tree]), remote);
    expect(makeDirectory).not.toHaveBeenCalled();
    expect(uploadWebFilesBatch).toHaveBeenCalledOnce();
    expect(uploadWebFilesBatch).toHaveBeenCalledWith(
      'drive:',
      '',
      expect.arrayContaining([expect.objectContaining({ relativePath: 'folder/a.txt' })]),
      'filemanager',
      ['folder/empty-parent/leaf']
    );
  });

  it('preserves a completely empty dropped folder and refreshes without uploading files', async () => {
    await service.dropToRemote(drop([directory('empty')]), remote);
    expect(makeDirectory).not.toHaveBeenCalled();
    expect(uploadWebFilesBatch).toHaveBeenCalledExactlyOnceWith('drive:', '', [], 'filemanager', [
      'empty',
    ]);
    expect(refresh).toHaveBeenCalledWith('drive', '');
  });

  it('reads every directory page before deciding whether a directory is empty', async () => {
    await service.dropToRemote(drop([directory('pages', [[file('one')], [file('two')]])]), remote);
    expect(makeDirectory).not.toHaveBeenCalled();
    expect(uploadWebFilesBatch.mock.calls[0][2]).toHaveLength(2);
  });

  it('does not misclassify an unreadable directory as empty', async () => {
    await service.dropToRemote(drop([directory('unreadable', [], true)]), remote);
    expect(makeDirectory).not.toHaveBeenCalled();
    expect(uploadWebFilesBatch).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith('nautilus.errors.externalDropFailed');
  });

  it('deduplicates entries from the same drop', async () => {
    const empty = directory('empty');
    const document = file('one');
    await service.dropToRemote(drop([empty, empty, document, document]), remote);
    expect(makeDirectory).not.toHaveBeenCalled();
    expect(uploadWebFilesBatch).toHaveBeenCalledOnce();
    expect(uploadWebFilesBatch.mock.calls[0][2]).toHaveLength(1);
    expect(uploadWebFilesBatch.mock.calls[0][4]).toEqual(['empty']);
  });
});
