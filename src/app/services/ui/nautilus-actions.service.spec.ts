import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Clipboard } from '@angular/cdk/clipboard';
import { TranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NautilusActionsService } from './nautilus-actions.service';
import { NautilusTabService } from './nautilus-tab.service';
import { NautilusSelectionService } from './nautilus-selection.service';
import { NautilusFileOperationsService } from './nautilus-file-operations.service';
import { NautilusService } from './nautilus.service';
import { NotificationService } from './notification.service';
import { ModalService } from './modal.service';
import { FileViewerService } from './file-viewer.service';
import { PathService } from '../infrastructure/platform/path.service';
import { RemoteFileOperationsService } from '../remote/remote-file-operations.service';
import { RemoteFacadeService } from '../facade/remote-facade.service';
import { DownloadService } from '../operations/download.service';
import { ExplorerRoot, FileBrowserItem } from '@app/types';

const remote: ExplorerRoot = { name: 'drive', label: 'Drive', isLocal: false, type: 'drive' };

describe('Nautilus action refresh destination', () => {
  let service: NautilusActionsService;
  const tab = {
    activeRemote: signal<ExplorerRoot | null>(remote),
    activePath: signal('original'),
    activeFiles: signal([]),
    refreshPath: vi.fn(),
  };
  const viewer = { open: vi.fn() };
  const fileOps = { openNewFolderDialog: vi.fn(), openCopyUrlDialog: vi.fn() };

  beforeEach(() => {
    tab.activeRemote.set(remote);
    tab.activePath.set('original');
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        NautilusActionsService,
        { provide: NautilusTabService, useValue: tab },
        { provide: NautilusFileOperationsService, useValue: fileOps },
        { provide: FileViewerService, useValue: viewer },
        ...[
          NautilusSelectionService,
          TranslateService,
          NotificationService,
          RemoteFileOperationsService,
          PathService,
          RemoteFacadeService,
          NautilusService,
          ModalService,
          DownloadService,
          Clipboard,
        ].map(provide => ({ provide, useValue: {} })),
      ],
    });
    service = TestBed.inject(NautilusActionsService);
  });

  it.each(['openNewFolder', 'openCopyUrlDialog'] as const)(
    '%s refreshes the original location after navigation changes',
    async action => {
      let resolve!: (result: boolean) => void;
      const operation =
        action === 'openNewFolder' ? fileOps.openNewFolderDialog : fileOps.openCopyUrlDialog;
      operation.mockImplementationOnce(
        () =>
          new Promise<boolean>(done => {
            resolve = done;
          })
      );
      const pending = service[action]();
      tab.activeRemote.set({ ...remote, name: 'other' });
      tab.activePath.set('elsewhere');
      resolve(true);
      await pending;
      expect(tab.refreshPath).toHaveBeenCalledExactlyOnceWith('drive', 'original');
    }
  );

  it('does not refresh a cancelled operation', async () => {
    fileOps.openNewFolderDialog.mockResolvedValueOnce(false);
    await service.openNewFolder();
    expect(tab.refreshPath).not.toHaveBeenCalled();
  });
  it('keeps preview navigation within the selected root and matches the full item identity', async () => {
    tab.activeRemote.set(null);
    const file = (root: string, id = ''): FileBrowserItem => ({
      entry: {
        ID: id,
        Name: 'photo.jpg',
        Path: 'photos/photo.jpg',
        IsDir: false,
        Size: 1,
        ModTime: '',
        MimeType: 'image/jpeg',
      },
      meta: { remote: root, isLocal: false },
    });
    const otherRoot = file('other');
    const first = file('drive', 'first');
    const selected = file('drive', 'selected');
    const next = {
      ...file('drive', 'next'),
      entry: { ...file('drive', 'next').entry, Path: 'photos/next.jpg' },
    };
    await service.openFilePreview(selected, [otherRoot, first, selected, next]);
    expect(viewer.open).toHaveBeenCalledExactlyOnceWith(
      [first.entry, selected.entry, next.entry],
      1,
      'drive',
      false
    );
  });

  it('does not preview a stale item absent from the pane', async () => {
    const selected: FileBrowserItem = {
      entry: {
        ID: '',
        Name: 'photo.jpg',
        Path: 'photo.jpg',
        IsDir: false,
        Size: 1,
        ModTime: '',
        MimeType: '',
      },
      meta: { remote: '/', isLocal: true },
    };
    await service.openFilePreview(selected, []);
    expect(viewer.open).not.toHaveBeenCalled();
  });
});
