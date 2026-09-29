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
import { ExplorerRoot } from '@app/types';

const remote: ExplorerRoot = { name: 'drive', label: 'Drive', isLocal: false, type: 'drive' };

describe('Nautilus action refresh destination', () => {
  let service: NautilusActionsService;
  const tab = {
    activeRemote: signal<ExplorerRoot | null>(remote),
    activePath: signal('original'),
    activeFiles: signal([]),
    refreshPath: vi.fn(),
  };
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
        ...[
          NautilusSelectionService,
          TranslateService,
          NotificationService,
          RemoteFileOperationsService,
          PathService,
          RemoteFacadeService,
          FileViewerService,
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
});
