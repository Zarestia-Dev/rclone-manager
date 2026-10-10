import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExplorerRoot, FileBrowserItem, fileBrowserItemKey } from '@app/types';
import {
  DragDropCallbacks,
  DragDropContext,
  NautilusDragDropService,
} from './nautilus-drag-drop.service';
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

describe('Nautilus mixed-root drop targets', () => {
  let service: NautilusDragDropService;
  let ctx: DragDropContext;
  let hitElement: HTMLElement;
  const roots: ExplorerRoot[] = [
    { name: '/', label: 'Unix', type: 'local', isLocal: true },
    { name: 'C:\\', label: 'Windows', type: 'local', isLocal: true },
    { name: 'drive', label: 'Cloud', type: 'drive', isLocal: false },
  ];
  const folder = (root: ExplorerRoot, path = 'shared'): FileBrowserItem => ({
    entry: { ID: '', Name: 'shared', Path: path, IsDir: true, Size: -1, ModTime: '', MimeType: '' },
    meta: { remote: root.name, isLocal: root.isLocal },
  });
  const performFileOperations = vi.fn();
  const refresh = vi.fn();
  const navigateTo = vi.fn();
  const openBookmark = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    ctx = {
      activeRemote: null,
      activePath: '',
      activePaneIndex: 0,
      panes: [
        { remote: null, path: '' },
        { remote: null, path: '' },
      ],
      files: roots.map(root => folder(root)),
      filesRight: [],
      pathSegments: [],
      tabs: [],
      allRemotesLookup: roots,
      bookmarks: roots.map(root => folder(root, '')),
    };
    hitElement = document.createElement('div');
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => hitElement),
    });
    TestBed.configureTestingModule({
      providers: [
        NautilusDragDropService,
        {
          provide: NautilusService,
          useValue: {
            lookupRemoteByName: (name: string): ExplorerRoot | null =>
              roots.find(root => root.name === name) ?? null,
          },
        },
        { provide: NautilusFileOperationsService, useValue: { performFileOperations } },
        {
          provide: PathService,
          useValue: {
            normalizeRemoteName: (name: string): string => name,
            getParentPath: (path: string): string =>
              path.slice(0, Math.max(0, path.lastIndexOf('/'))),
          },
        },
        { provide: NotificationService, useValue: {} },
        { provide: TranslateService, useValue: {} },
      ],
    });
    service = TestBed.inject(NautilusDragDropService);
    service.register({
      getContext: () => ctx,
      refresh,
      navigateTo,
      openBookmark,
    } as unknown as DragDropCallbacks);
  });
  afterEach(() => {
    service.endDrag();
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, 'elementFromPoint');
  });

  function pointAt(item: FileBrowserItem, sidebar = false): void {
    hitElement.setAttribute(
      sidebar ? 'data-sidebar-bookmark-key' : 'data-folder-key',
      fileBrowserItemKey(item)
    );
    if (!sidebar) hitElement.setAttribute('data-pane-index', '0');
  }

  it.each([0, 1, 2])('resolves starred folder %s despite identical relative paths', index => {
    pointAt(ctx.files[index]);
    expect(service['_resolveDropTargetFromPoint'](0, 0)).toEqual({
      remote: roots[index],
      path: 'shared',
    });
  });
  it.each([0, 1, 2])('resolves bookmarked root %s with an empty relative path', index => {
    pointAt(ctx.bookmarks[index], true);
    expect(service['_resolveDropTargetFromPoint'](0, 0)).toEqual({
      remote: roots[index],
      path: '',
    });
  });
  it('does not treat the starred background as a filesystem destination', () => {
    hitElement.setAttribute('data-pane-index', '0');
    expect(service['_resolveDropTargetFromPoint'](0, 0).remote).toBeNull();
  });
  it('does not fall back to another root for an unavailable folder', () => {
    const missing = folder({ ...roots[0], name: 'unavailable' });
    ctx.files = [missing];
    ctx.panes[0].remote = roots[1];
    pointAt(missing);
    expect(service['_resolveDropTargetFromPoint'](0, 0).remote).toBeNull();
  });
  it('allows identical relative paths on different roots', async () => {
    await service['_processInternalItemsDrop']([ctx.files[0]], {
      remote: roots[1],
      path: 'shared',
    });
    expect(performFileOperations).toHaveBeenCalledExactlyOnceWith(
      [ctx.files[0]],
      roots[1],
      'shared',
      'copy'
    );
  });
  it('prevents dropping a folder into itself', async () => {
    await service['_processInternalItemsDrop']([ctx.files[0]], {
      remote: roots[0],
      path: 'shared',
    });
    expect(performFileOperations).not.toHaveBeenCalled();
  });
  it('resolves the starred target for browser drops too', async () => {
    pointAt(ctx.files[1]);
    const process = vi
      .spyOn(
        service as unknown as { _processDrop: (...args: unknown[]) => Promise<void> },
        '_processDrop'
      )
      .mockResolvedValue();
    const event = { stopPropagation: vi.fn(), clientX: 0, clientY: 0 } as unknown as DragEvent;
    await service.dropToCurrentDirectory(event, 0);
    expect(process).toHaveBeenCalledWith(event, { remote: roots[1], path: 'shared' }, []);
  });
  it('hover-opens the correct bookmark among identical paths', () => {
    vi.useFakeTimers();
    service['_isInternalDragging'].set(true);
    pointAt(ctx.bookmarks[1], true);
    service['_onMove']({ x: 0, y: 0 });
    vi.advanceTimersByTime(1000);
    expect(openBookmark).toHaveBeenCalledExactlyOnceWith(ctx.bookmarks[1]);
  });
  it('hover-opens a different root even when its folder path matches the dragged folder', () => {
    vi.useFakeTimers();
    service['_isInternalDragging'].set(true);
    service['_items'] = [ctx.files[0]];
    pointAt(ctx.files[1]);
    service['_onMove']({ x: 0, y: 0 });
    vi.advanceTimersByTime(1000);
    expect(navigateTo).toHaveBeenCalledExactlyOnceWith(ctx.files[1]);
  });
  it('skips only items already in the destination when a starred selection spans parents', async () => {
    const alreadyThere = folder(roots[0], 'target/first');
    const elsewhere = folder(roots[0], 'other/second');
    await service['_processInternalItemsDrop']([alreadyThere, elsewhere], {
      remote: roots[0],
      path: 'target',
    });
    expect(performFileOperations).toHaveBeenCalledExactlyOnceWith(
      [elsewhere],
      roots[0],
      'target',
      'move'
    );
  });
});
