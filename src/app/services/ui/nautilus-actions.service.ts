import { inject, Injectable, signal, computed } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { RemoteFileOperationsService } from 'src/app/services/remote/remote-file-operations.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { ExplorerRoot, FileBrowserItem, RemoteFeatures } from '@app/types';
import { NautilusService } from 'src/app/services/ui/nautilus.service';
import { NautilusFileOperationsService } from './nautilus-file-operations.service';
import { NautilusTabService } from './nautilus-tab.service';
import { Clipboard } from '@angular/cdk/clipboard';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { MultiRenameModalComponent } from 'src/app/shared/modals/multi-rename-modal/multi-rename-modal.component';
import { FileViewerService } from './file-viewer.service';

@Injectable()
export class NautilusActionsService {
  private readonly tabSvc = inject(NautilusTabService);
  private readonly fileOps = inject(NautilusFileOperationsService);
  private readonly translate = inject(TranslateService);
  private readonly notificationService = inject(NotificationService);
  private readonly remoteOps = inject(RemoteFileOperationsService);
  private readonly pathSvc = inject(PathService);
  private readonly remoteFacadeSvc = inject(RemoteFacadeService);
  private readonly fileViewerSvc = inject(FileViewerService);
  private readonly nautilusService = inject(NautilusService);
  private readonly clipboard = inject(Clipboard);
  private readonly dialog = inject(MatDialog);

  readonly contextMenuItem = signal<FileBrowserItem | null>(null);

  openPropertiesDialog(source: 'contextMenu' | 'bookmark', itemOverride?: FileBrowserItem): void {
    const activeRemote = this.tabSvc.activeRemote();
    const item = itemOverride ?? this.contextMenuItem();
    if (source === 'bookmark' && !item) return;

    const path = item?.entry.Path ?? this.tabSvc.activePath();
    const isLocal = item?.meta.isLocal ?? activeRemote?.isLocal ?? true;

    let remoteName = item?.meta.remote ?? activeRemote?.name;
    if (remoteName && !isLocal) {
      remoteName = this.pathSvc.normalizeRemoteForRclone(remoteName);
    }

    const baseName = this.pathSvc.normalizeRemoteName(
      item?.meta.remote ?? activeRemote?.name ?? ''
    );
    const features = this.remoteFacadeSvc.featuresSignal(baseName)() as RemoteFeatures;

    this.nautilusService.openProperties({
      remoteName,
      path,
      isLocal,
      item: item?.entry,
      remoteType: item?.meta.remoteType ?? activeRemote?.type,
      features,
      height: '60vh',
      maxHeight: '800px',
      width: '60vw',
      maxWidth: '400px',
    });
  }

  openShortcutsModal(): void {
    this.nautilusService.openKeyboardShortcuts({ nautilus: true });
  }

  openAboutModal(remote: ExplorerRoot): void {
    const normalized = remote.isLocal
      ? remote.name
      : this.pathSvc.normalizeRemoteForRclone(remote.name);
    this.nautilusService.openRemoteAbout({
      displayName: remote.name,
      normalizedName: normalized,
      type: remote.type,
    });
  }

  async confirmAndCleanup(r: ExplorerRoot): Promise<void> {
    const confirmed = await this.notificationService.confirmModal(
      this.translate.instant('nautilus.modals.emptyTrash.title'),
      this.translate.instant('nautilus.modals.emptyTrash.message', { remote: r.name }),
      'common.delete',
      'common.cancel',
      { icon: 'trash', color: 'warn' }
    );
    if (!confirmed) return;

    try {
      const normalized = r.isLocal ? r.name : this.pathSvc.normalizeRemoteForRclone(r.name);
      await this.remoteOps.cleanup(normalized, undefined, 'filemanager');
      this.notificationService.showInfo(
        this.translate.instant('nautilus.notifications.trashEmptied')
      );
    } catch (e) {
      this.notificationService.showError(
        this.translate.instant('nautilus.errors.emptyTrashFailed', {
          error: (e as Error).message,
        })
      );
    }
  }

  async openFilePreview(item: FileBrowserItem, activePaneFiles: FileBrowserItem[]): Promise<void> {
    const currentRemote = this.tabSvc.nautilusRemote();
    const actualRemoteName = item.meta.remote ?? currentRemote?.name;
    if (!actualRemoteName) {
      this.notificationService.showError(this.translate.instant('nautilus.errors.openFileFailed'));
      return;
    }

    const isLocal = item.meta.isLocal;
    const idx = activePaneFiles.findIndex(f => f.entry.Path === item.entry.Path);
    if (idx === -1) return;

    this.fileViewerSvc.open(
      activePaneFiles.map(f => f.entry),
      idx,
      actualRemoteName,
      isLocal
    );
  }

  async openNewFolder(): Promise<void> {
    const remote = this.tabSvc.activeRemote();
    if (!remote) return;

    const existingNames = this.tabSvc.activeFiles().map(f => f.entry.Name);
    const created = await this.fileOps.openNewFolderDialog(
      remote,
      this.tabSvc.activePath(),
      existingNames
    );
    if (created) this._refresh();
  }

  async openCopyUrlDialog(): Promise<void> {
    const remote = this.tabSvc.activeRemote();
    if (!remote) return;

    const changed = await this.fileOps.openCopyUrlDialog(remote, this.tabSvc.activePath());
    if (changed) this._refresh();
  }

  async openRename(): Promise<void> {
    const item = this.contextMenuItem();
    const remote = this.tabSvc.activeRemote();
    if (!item || !remote) return;

    const existingNames = this.tabSvc
      .activeFiles()
      .filter(f => f.entry.Name !== item.entry.Name)
      .map(f => f.entry.Name);

    const changed = await this.fileOps.openRenameDialog(remote, item, existingNames);
    if (changed) this._refresh();
  }

  async deleteSelectedItems(): Promise<void> {
    const remote = this.tabSvc.activeRemote();
    if (!remote) return;

    const selection = this.tabSvc.selectedItems();
    let itemsToDelete = this.tabSvc.activeFiles().filter(f => selection.has(this._itemKey(f)));

    const ctx = this.contextMenuItem();
    if (ctx && !selection.has(this._itemKey(ctx))) {
      itemsToDelete = [ctx];
    }

    const refreshNeeded = await this.fileOps.deleteItems(remote, itemsToDelete);
    if (refreshNeeded) {
      this.tabSvc.syncSelection(new Set(), this.tabSvc.activePaneIndex() as 0 | 1);
      this._refresh();
    }
  }

  async removeEmptyDirs(): Promise<void> {
    const remote = this.tabSvc.activeRemote();
    if (!remote) return;

    const selection = this.tabSvc.selectedItems();
    const item =
      this.contextMenuItem() ??
      this.tabSvc.activeFiles().find(f => selection.has(this._itemKey(f)) && f.entry.IsDir);
    if (!item) return;

    const changed = await this.fileOps.removeEmptyDirs(remote, item);
    if (changed) this._refresh();
  }

  async openArchiveCreate(): Promise<void> {
    const remote = this.tabSvc.activeRemote();
    if (!remote) return;

    const selection = this.tabSvc.selectedItems();
    let selectedFiles = this.tabSvc.activeFiles().filter(f => selection.has(this._itemKey(f)));

    const ctx = this.contextMenuItem();
    if (ctx && !selection.has(this._itemKey(ctx))) {
      selectedFiles = [ctx];
    }

    if (selectedFiles.length === 0) return;

    const changed = await this.fileOps.openArchiveCreateDialog(
      remote,
      selectedFiles,
      this.tabSvc.activePath()
    );
    if (changed) this._refresh();
  }

  openContextMenuOpenInNewTab(): void {
    const item = this.contextMenuItem();
    if (!item?.entry.IsDir) return;

    let root = this.tabSvc.activeRemote();
    if (!root && item.meta.remote) {
      const remoteName = this.pathSvc.normalizeRemoteName(item.meta.remote);
      root =
        this.nautilusService
          .allRemotesLookup()
          .find(r => this.pathSvc.normalizeRemoteName(r.name) === remoteName) ?? null;
    }

    if (root) {
      this.tabSvc.createTab(root, item.entry.Path);
    } else {
      console.warn('Could not resolve ExplorerRoot for item', item);
      this.notificationService.showError(this.translate.instant('fileBrowser.resolveRemoteFailed'));
    }
  }

  openContextMenuOpenInNewWindow(): void {
    const item = this.contextMenuItem();
    if (!item?.entry.IsDir) return;
    this.nautilusService.newNautilusWindow(item.meta.remote, item.entry.Path);
  }

  openBookmarkInNewTab(bookmark: FileBrowserItem): void {
    const remote = this._resolveBookmarkRemote(bookmark);
    if (remote) this.tabSvc.createTab(remote, bookmark.entry.Path);
  }

  openBookmarkInNewWindow(bookmark: FileBrowserItem): void {
    const remote = this._resolveBookmarkRemote(bookmark);
    if (remote) this.nautilusService.newNautilusWindow(remote.name, bookmark.entry.Path);
  }

  readonly supportsPublicLink = computed(() => {
    const item = this.contextMenuItem();
    const remote = this.tabSvc.activeRemote();
    const activeRemoteName = item?.meta.remote ?? remote?.name;
    if (!activeRemoteName) return false;
    const isLocal = item?.meta.isLocal ?? remote?.isLocal ?? true;
    if (isLocal) return false;
    const baseName = this.pathSvc.normalizeRemoteName(activeRemoteName);
    const features = this.remoteFacadeSvc.featuresSignal(baseName)() as RemoteFeatures;
    return !!features?.PublicLink;
  });

  async copyPublicLink(): Promise<void> {
    const item = this.contextMenuItem();
    const remote = this.tabSvc.activeRemote();
    if (!item || !remote) return;

    const remoteName = this.pathSvc.normalizeRemoteForRclone(item.meta.remote ?? remote.name);
    this.notificationService.showInfo(
      this.translate.instant('nautilus.notifications.getPublicLinkStarted')
    );

    try {
      const result = await this.remoteOps.getPublicLink(remoteName, item.entry.Path);
      if (result && result.url) {
        const success = this.clipboard.copy(result.url);
        if (success) {
          this.notificationService.showSuccess(this.translate.instant('common.copied'));
        } else {
          this.notificationService.showError(this.translate.instant('common.copyFailed'));
        }
      } else {
        this.notificationService.showError(
          this.translate.instant('fileBrowser.properties.failGetLink')
        );
      }
    } catch (err) {
      console.error('Failed to get public link:', err);
      this.notificationService.showError(
        this.translate.instant('fileBrowser.properties.failGetLink')
      );
    }
  }

  async createFolderWithSelectedItems(): Promise<void> {
    const remote = this.tabSvc.activeRemote();
    if (!remote) return;

    const items = this._getSelectedItemsList(this.tabSvc.activeFiles());
    if (items.length === 0) return;

    const existingNames = this.tabSvc.activeFiles().map(f => f.entry.Name);
    const ref = this.notificationService.openInput({
      title: this.translate.instant('nautilus.modals.newFolder.title'),
      label: this.translate.instant('nautilus.modals.newFolder.label'),
      icon: 'folder',
      placeholder: this.translate.instant('nautilus.modals.newFolder.placeholder'),
      existingNames,
    });

    try {
      const folderName = await firstValueFrom(ref.afterClosed());
      if (!folderName) return;

      const currentPath = this.tabSvc.activePath();
      const newPath = this.pathSvc.joinPath(currentPath, folderName);
      const normalizedRemote = this.pathSvc.normalizeRemoteForRclone(remote.name);

      await this.remoteOps.makeDirectory(normalizedRemote, newPath, 'filemanager');
      await this.fileOps.performFileOperations(items, remote, newPath, 'move');

      this.tabSvc.syncSelection(new Set(), this.tabSvc.activePaneIndex() as 0 | 1);
      this._refresh();
    } catch (err) {
      console.error('Failed to create folder with selected items', err);
      this.notificationService.showError(
        this.translate.instant('nautilus.errors.createFolderFailed', {
          name: 'selection',
          error: (err as Error).message || String(err),
        })
      );
    }
  }

  async openMultiRename(): Promise<void> {
    const remote = this.tabSvc.activeRemote();
    if (!remote) return;

    const items = this._getSelectedItemsList(this.tabSvc.activeFiles());
    if (items.length === 0) return;

    const ref = this.dialog.open(MultiRenameModalComponent, {
      data: { items, remote },
      disableClose: true,
    });

    const changed = await firstValueFrom(ref.afterClosed());
    if (changed) {
      this.tabSvc.syncSelection(new Set(), this.tabSvc.activePaneIndex() as 0 | 1);
      this._refresh();
    }
  }

  private _refresh(): void {
    const remote = this.tabSvc.activeRemote();
    if (remote) {
      this.tabSvc.refreshPath(remote.name, this.tabSvc.activePath());
    } else {
      this.tabSvc.refresh(this.tabSvc.activePaneIndex() as 0 | 1);
    }
  }

  private _itemKey(item: FileBrowserItem): string {
    return `${item.meta.remote}:${item.entry.Path}`;
  }

  private _resolveBookmarkRemote(bookmark: FileBrowserItem): ExplorerRoot | null {
    const remote =
      this.nautilusService
        .allRemotesLookup()
        .find(
          r =>
            this.pathSvc.normalizeRemoteName(r.name) ===
            this.pathSvc.normalizeRemoteName(bookmark.meta.remote)
        ) ?? null;

    if (!remote) {
      this.notificationService.showError(
        this.translate.instant('nautilus.errors.bookmarkRemoteNotFound', {
          remote: bookmark.meta.remote,
        })
      );
    }
    return remote;
  }

  private _getSelectedItemsList(currentFiles: FileBrowserItem[]): FileBrowserItem[] {
    const selection =
      this.tabSvc.activePaneIndex() === 0
        ? this.tabSvc.selectedItems()
        : this.tabSvc.selectedItemsRight();
    return currentFiles.filter((item: FileBrowserItem) => selection.has(this._itemKey(item)));
  }
}
