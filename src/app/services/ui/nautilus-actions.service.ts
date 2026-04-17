import { inject, Injectable, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import {
  NotificationService,
  PathSelectionService,
  RemoteFileOperationsService,
  RemoteFacadeService,
  ModalService,
} from '@app/services';
import { ExplorerRoot, FileBrowserItem, ORIGINS, RemoteFeatures } from '@app/types';
import { NautilusService } from '@app/services';
import { NautilusFileOperationsService } from './nautilus-file-operations.service';
import { NautilusTabService } from './nautilus-tab.service';
import { FileViewerService } from '../ui/file-viewer.service';
import { isLocalPath } from '../remote/utils/remote-config.utils';

/**
 * Handles all context-menu and dialog-driven actions for the Nautilus file
 * browser.  Lives at component scope so it can reference the component-scoped
 * NautilusTabService and NautilusFileOperationsService.
 *
 * Owns `contextMenuItem` — the item last right-clicked or activated via
 * keyboard.  `setContextItem` in the parent component sets this signal and
 * handles the pane-switch / selection-sync side-effect.
 */
@Injectable()
export class NautilusActionsService {
  private readonly tabSvc = inject(NautilusTabService);
  private readonly fileOps = inject(NautilusFileOperationsService);
  private readonly modalService = inject(ModalService);
  private readonly translate = inject(TranslateService);
  private readonly notificationService = inject(NotificationService);
  private readonly remoteOps = inject(RemoteFileOperationsService);
  private readonly pathSvc = inject(PathSelectionService);
  private readonly remoteFacadeSvc = inject(RemoteFacadeService);
  private readonly fileViewerSvc = inject(FileViewerService);
  private readonly nautilusService = inject(NautilusService);

  /** The item that was last right-clicked (or null for empty-area clicks). */
  readonly contextMenuItem = signal<FileBrowserItem | null>(null);

  // ── Dialogs ─────────────────────────────────────────────────────────────────

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

    this.modalService.openProperties({
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
    this.modalService.openKeyboardShortcuts({ nautilus: true });
  }

  openAboutModal(remote: ExplorerRoot): void {
    const normalized = remote.isLocal
      ? remote.name
      : this.pathSvc.normalizeRemoteForRclone(remote.name);
    this.modalService.openRemoteAbout({
      displayName: remote.name,
      normalizedName: normalized,
      type: remote.type,
    });
  }

  async confirmAndCleanup(r: ExplorerRoot): Promise<void> {
    const confirmed = await this.notificationService.confirmModal(
      this.translate.instant('nautilus.modals.emptyTrash.title'),
      this.translate.instant('nautilus.modals.emptyTrash.message', { remote: r.name }),
      undefined,
      undefined,
      { icon: 'trash', color: 'warn' }
    );
    if (!confirmed) return;

    try {
      const normalized = r.isLocal ? r.name : this.pathSvc.normalizeRemoteForRclone(r.name);
      await this.remoteOps.cleanup(normalized, undefined, ORIGINS.FILEMANAGER);
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

  // ── Context-menu file actions ────────────────────────────────────────────────

  copyContextItemPath(): void {
    const item = this.contextMenuItem();
    const remote = this.tabSvc.activeRemote();
    if (!item || !remote) return;

    const cleanRemote = remote.isLocal
      ? remote.name
      : this.pathSvc.normalizeRemoteForRclone(remote.name) + ':';

    navigator.clipboard?.writeText(`${cleanRemote}${item.entry.Path}`.replace('//', '/'));
  }

  /**
   * Opens the file viewer.
   * The caller must supply the sorted/filtered file list from the active pane
   * so that previous/next navigation in the viewer is correct.
   */
  async openFilePreview(item: FileBrowserItem, activePaneFiles: FileBrowserItem[]): Promise<void> {
    const currentRemote = this.tabSvc.nautilusRemote();
    const actualRemoteName = item.meta.remote ?? currentRemote?.name;
    if (!actualRemoteName) {
      this.notificationService.showError(this.translate.instant('nautilus.errors.openFileFailed'));
      return;
    }

    const baseName = this.pathSvc.normalizeRemoteName(actualRemoteName);
    const features = this.remoteFacadeSvc.featuresSignal(baseName)() as RemoteFeatures;
    const isLocal =
      features?.isLocal ??
      item.meta.isLocal ??
      currentRemote?.isLocal ??
      isLocalPath(actualRemoteName);

    const idx = activePaneFiles.findIndex(f => f.entry.Path === item.entry.Path);
    if (idx === -1) return;

    this.fileViewerSvc.open(
      activePaneFiles.map(f => f.entry),
      idx,
      actualRemoteName,
      isLocal
    );
  }

  // ── File operations (delegate to NautilusFileOperationsService + refresh) ───

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

  // ── Tab/window openers ───────────────────────────────────────────────────────

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

  // ── Private helpers ──────────────────────────────────────────────────────────

  private _refresh(): void {
    this.tabSvc.refresh(this.tabSvc.activePaneIndex() as 0 | 1);
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
}
