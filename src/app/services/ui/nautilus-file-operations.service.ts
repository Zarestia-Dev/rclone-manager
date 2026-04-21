import { computed, inject, Injectable, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

import {
  NotificationService,
  PathSelectionService,
  RemoteFileOperationsService,
  ModalService,
} from '@app/services';
import { ExplorerRoot, FileBrowserItem, ORIGINS } from '@app/types';
import { firstValueFrom } from 'rxjs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UndoEntry {
  mode: 'copy' | 'move';
  items: {
    srcRemote: string;
    srcPath: string;
    dstRemote: string;
    dstFullPath: string;
    isDir: boolean;
    name: string;
  }[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Manages clipboard state, undo/redo stack, and all file mutation operations
 * (copy, cut, paste, move, delete, rename, mkdir, cleanup).
 *
 * Provided at the NautilusComponent level so it shares the same lifetime.
 * Methods accept the active context (remote, path, files) as parameters so
 * the service has no signal dependency back on the component.
 */
@Injectable()
export class NautilusFileOperationsService {
  private readonly MAX_UNDO_STACK = 20;

  private readonly translate = inject(TranslateService);
  private readonly modalService = inject(ModalService);
  private readonly remoteOps = inject(RemoteFileOperationsService);
  private readonly notifications = inject(NotificationService);
  private readonly pathSelection = inject(PathSelectionService);

  // ---------------------------------------------------------------------------
  // Clipboard state
  // ---------------------------------------------------------------------------

  readonly clipboardItems = signal<
    { remote: string; path: string; name: string; isDir: boolean }[]
  >([]);
  readonly clipboardMode = signal<'copy' | 'cut' | null>(null);

  readonly hasClipboard = computed(() => this.clipboardItems().length > 0);
  readonly cutItemPaths = computed(() => {
    if (this.clipboardMode() !== 'cut') return new Set<string>();
    return new Set(this.clipboardItems().map(i => `${i.remote}:${i.path}`));
  });

  // ---------------------------------------------------------------------------
  // Undo / Redo stack
  // ---------------------------------------------------------------------------

  private readonly _undoStack = signal<UndoEntry[]>([]);
  private readonly _redoStack = signal<UndoEntry[]>([]);

  readonly canUndo = computed(() => this._undoStack().length > 0);
  readonly canRedo = computed(() => this._redoStack().length > 0);

  // ---------------------------------------------------------------------------
  // Clipboard helpers
  // ---------------------------------------------------------------------------

  copyItems(items: FileBrowserItem[]): void {
    this._setClipboard(items, 'copy');
  }

  cutItems(items: FileBrowserItem[]): void {
    this._setClipboard(items, 'cut');
  }

  clearClipboard(): void {
    this.clipboardItems.set([]);
    this.clipboardMode.set(null);
  }

  private _setClipboard(items: FileBrowserItem[], mode: 'copy' | 'cut'): void {
    if (items.length === 0) return;
    this.clipboardItems.set(
      items.map(item => ({
        remote: item.meta.remote,
        path: item.entry.Path,
        name: item.entry.Name,
        isDir: item.entry.IsDir,
      }))
    );
    this.clipboardMode.set(mode);
  }

  // ---------------------------------------------------------------------------
  // Paste
  // ---------------------------------------------------------------------------

  async pasteItems(
    dstRemote: ExplorerRoot | null,
    dstPath: string,
    allRemotes: ExplorerRoot[]
  ): Promise<boolean> {
    const clipboardData = this.clipboardItems();
    const mode = this.clipboardMode();
    if (clipboardData.length === 0 || !dstRemote || !mode) return false;

    const items: FileBrowserItem[] = clipboardData.map(item => {
      const remoteInfo = allRemotes.find(r => r.name === item.remote);
      return {
        entry: {
          Name: item.name,
          Path: item.path,
          IsDir: item.isDir,
          ID: '',
          Size: 0,
          ModTime: '',
          MimeType: '',
        },
        meta: {
          remote: item.remote,
          isLocal: remoteInfo?.isLocal ?? false,
          remoteType: remoteInfo?.type,
        },
      };
    });

    await this.performFileOperations(items, dstRemote, dstPath, mode === 'cut' ? 'move' : 'copy');
    if (mode === 'cut') this.clearClipboard();
    return true;
  }

  // ---------------------------------------------------------------------------
  // File operations (copy / move / delete / rename / mkdir)
  // ---------------------------------------------------------------------------

  async performFileOperations(
    items: FileBrowserItem[],
    dstRemote: ExplorerRoot,
    dstPath: string,
    mode: 'copy' | 'move'
  ): Promise<void> {
    if (items.length === 0) return;

    const normalizedDst = this.pathSelection.normalizeRemoteForRclone(dstRemote.name);
    const transferItems = items.map(item => ({
      srcRemote: this.pathSelection.normalizeRemoteForRclone(item.meta.remote ?? ''),
      srcPath: item.entry.Path,
      name: item.entry.Name,
      isDir: !!item.entry.IsDir,
    }));

    this.notifications.showInfo(
      this.translate.instant(
        mode === 'copy'
          ? 'nautilus.notifications.copyStarted'
          : 'nautilus.notifications.moveStarted',
        { count: items.length }
      )
    );

    try {
      await this.remoteOps.transferItems(
        transferItems,
        normalizedDst,
        dstPath,
        mode,
        ORIGINS.FILEMANAGER
      );

      // Successfully dispatched batch!
      const succeededItems: UndoEntry['items'] = items.map(item => ({
        srcRemote: this.pathSelection.normalizeRemoteForRclone(item.meta.remote ?? ''),
        srcPath: item.entry.Path,
        dstRemote: normalizedDst,
        dstFullPath: dstPath ? `${dstPath}/${item.entry.Name}` : item.entry.Name,
        isDir: !!item.entry.IsDir,
        name: item.entry.Name,
      }));

      this._undoStack.update(s => [
        ...s.slice(-(this.MAX_UNDO_STACK - 1)),
        { mode, items: succeededItems },
      ]);
      this._redoStack.set([]);
    } catch (e) {
      console.error(`${mode} batch failed`, e);
      this.notifications.showError(
        this.translate.instant(
          mode === 'copy' ? 'nautilus.errors.copyFailed' : 'nautilus.errors.moveFailed',
          { count: items.length }
        )
      );
    }
  }

  async deleteItems(remote: ExplorerRoot, items: FileBrowserItem[]): Promise<boolean> {
    if (items.length === 0) return false;

    const isMultiple = items.length > 1;
    const message = isMultiple
      ? this.translate.instant('nautilus.modals.delete.messageMultiple', { count: items.length })
      : this.translate.instant('nautilus.modals.delete.messageSingle', {
          name: items[0].entry.Name,
        });

    const confirmed = await this.notifications.confirmModal(
      this.translate.instant('nautilus.modals.delete.title'),
      message,
      undefined,
      undefined,
      { icon: 'trash', color: 'warn' }
    );
    if (!confirmed) return false;

    const normalizedRemote = this._normalizeRemote(remote);

    this.notifications.showInfo(
      this.translate.instant('nautilus.notifications.deleteStarted', { count: items.length })
    );

    const deleteItems = items.map(item => ({
      remote: normalizedRemote,
      path: item.entry.Path,
      isDir: !!item.entry.IsDir,
    }));

    try {
      await this.remoteOps.deleteItems(deleteItems, ORIGINS.FILEMANAGER);
      return true; // signal caller to refresh
    } catch (e) {
      console.error('Batch delete failed', e);
      this.notifications.showError(
        this.translate.instant('nautilus.errors.deleteFailed', {
          count: items.length,
          total: items.length,
        })
      );
      return false;
    }
  }

  async openRenameDialog(
    remote: ExplorerRoot,
    item: FileBrowserItem,
    existingNames: string[]
  ): Promise<boolean> {
    const normalizedRemote = this._normalizeRemote(remote);

    const ref = this.modalService.openInput({
      title: this.translate.instant('nautilus.modals.rename.title'),
      label: this.translate.instant('nautilus.modals.rename.label'),
      icon: 'pen',
      placeholder: this.translate.instant('nautilus.modals.rename.placeholder'),
      initialValue: item.entry.Name,
      createLabel: this.translate.instant('nautilus.modals.rename.confirm'),
      existingNames,
    });

    try {
      const newName = await firstValueFrom(ref.afterClosed());
      if (!newName || newName === item.entry.Name) return false;

      const pathParts = item.entry.Path.split('/');
      pathParts[pathParts.length - 1] = newName;
      const newPath = pathParts.join('/');

      if (item.entry.IsDir) {
        await this.remoteOps.renameDir(
          normalizedRemote,
          item.entry.Path,
          newPath,
          ORIGINS.FILEMANAGER
        );
      } else {
        await this.remoteOps.renameFile(
          normalizedRemote,
          item.entry.Path,
          newPath,
          ORIGINS.FILEMANAGER
        );
      }

      this.notifications.showSuccess(
        this.translate.instant('nautilus.notifications.renameStarted')
      );
      return true;
    } catch {
      this.notifications.showError(this.translate.instant('nautilus.errors.renameFailed'));
      return false;
    }
  }

  async openNewFolderDialog(
    remote: ExplorerRoot,
    currentPath: string,
    existingNames: string[]
  ): Promise<boolean> {
    const normalizedRemote = this._normalizeRemote(remote);

    const ref = this.modalService.openInput({
      title: this.translate.instant('nautilus.modals.newFolder.title'),
      label: this.translate.instant('nautilus.modals.newFolder.label'),
      icon: 'folder',
      placeholder: this.translate.instant('nautilus.modals.newFolder.placeholder'),
      existingNames,
    });

    try {
      const folderName = await firstValueFrom(ref.afterClosed());
      if (!folderName) return false;

      const sep = remote.isLocal && (currentPath === '' || currentPath.endsWith('/')) ? '' : '/';
      const newPath = currentPath ? `${currentPath}${sep}${folderName}` : folderName;
      await this.remoteOps.makeDirectory(normalizedRemote, newPath, ORIGINS.FILEMANAGER);
      return true;
    } catch {
      this.notifications.showError(this.translate.instant('nautilus.errors.createFolderFailed'));
      return false;
    }
  }

  async openCopyUrlDialog(remote: ExplorerRoot, currentPath: string): Promise<boolean> {
    const normalizedRemote = this._normalizeRemote(remote);

    const ref = this.modalService.openInput({
      title: this.translate.instant('nautilus.modals.copyUrl.title'),
      icon: 'download',
      createLabel: this.translate.instant('nautilus.modals.copyUrl.confirm'),
      fields: [
        {
          key: 'url',
          label: this.translate.instant('nautilus.modals.copyUrl.urlLabel'),
          placeholder: 'https://example.com/file.zip',
          required: true,
          type: 'url',
        },
        {
          key: 'filename',
          label: this.translate.instant('nautilus.modals.copyUrl.fileLabel'),
          placeholder: this.translate.instant('nautilus.modals.copyUrl.filePlaceholder'),
          required: false,
          forbiddenChars: true,
        },
      ],
    });

    try {
      const result = await firstValueFrom(ref.afterClosed());
      if (!result || !result.url) return false;

      const { url, filename } = result;
      const autoFilename = !filename || filename.trim() === '';
      const targetFilename = filename?.trim();
      const targetPath = !autoFilename
        ? currentPath
          ? `${currentPath}/${targetFilename}`
          : targetFilename
        : currentPath;

      this.notifications.showInfo(this.translate.instant('nautilus.notifications.copyUrlStarted'));

      await this.remoteOps.copyUrl(
        normalizedRemote,
        targetPath,
        url.trim(),
        autoFilename,
        ORIGINS.FILEMANAGER
      );

      return true;
    } catch (e) {
      this.notifications.showError(
        this.translate.instant('nautilus.errors.copyUrlFailed', {
          error: (e as Error).message,
        })
      );
      return false;
    }
  }

  async removeEmptyDirs(remote: ExplorerRoot, item: FileBrowserItem): Promise<boolean> {
    if (!item.entry.IsDir) return false;

    const confirmed = await this.notifications.confirmModal(
      this.translate.instant('nautilus.modals.rmdirs.title'),
      this.translate.instant('nautilus.modals.rmdirs.message', { name: item.entry.Name }),
      this.translate.instant('nautilus.modals.rmdirs.confirm'),
      undefined,
      { icon: 'broom', color: 'accent' }
    );
    if (!confirmed) return false;

    const normalizedRemote = this.pathSelection.normalizeRemoteForRclone(remote.name);
    try {
      this.notifications.showInfo(
        this.translate.instant('nautilus.notifications.rmdirsStarted', { name: item.entry.Name })
      );
      await this.remoteOps.removeEmptyDirs(normalizedRemote, item.entry.Path, ORIGINS.FILEMANAGER);
      return true;
    } catch (e) {
      this.notifications.showError(
        this.translate.instant('nautilus.errors.rmdirsFailed', {
          name: item.entry.Name,
          error: (e as any).message || String(e),
        })
      );
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Undo / Redo
  // ---------------------------------------------------------------------------

  async undoLastOperation(): Promise<void> {
    const stack = this._undoStack();
    if (stack.length === 0) return;

    const entry = stack[stack.length - 1];
    this._undoStack.set(stack.slice(0, -1));

    try {
      if (entry.mode === 'copy') {
        const itemsToDelete = entry.items.map(item => ({
          remote: item.dstRemote,
          path: item.dstFullPath,
          isDir: item.isDir,
        }));
        await this.remoteOps.deleteItems(itemsToDelete, ORIGINS.FILEMANAGER);
      } else {
        // Move back: src becomes dst, dst becomes src
        // We group by original source (which is now our destination) to use batch transfers
        const groups = new Map<string, { dstRemote: string; dstPath: string; items: any[] }>();

        for (const item of entry.items) {
          const lastSlash = item.srcPath.lastIndexOf('/');
          const dstParentPath = lastSlash > -1 ? item.srcPath.substring(0, lastSlash) : '';
          const key = `${item.srcRemote}:${dstParentPath}`;

          if (!groups.has(key)) {
            groups.set(key, {
              dstRemote: item.srcRemote,
              dstPath: dstParentPath,
              items: [],
            });
          }

          groups.get(key)!.items.push({
            srcRemote: item.dstRemote,
            srcPath: item.dstFullPath,
            name: item.name,
            isDir: item.isDir,
          });
        }

        for (const group of groups.values()) {
          await this.remoteOps.transferItems(
            group.items,
            group.dstRemote,
            group.dstPath,
            'move',
            ORIGINS.FILEMANAGER
          );
        }
      }
      this._redoStack.update(s => [...s.slice(-(this.MAX_UNDO_STACK - 1)), entry]);
      this.notifications.showSuccess(this.translate.instant('nautilus.notifications.undoComplete'));
    } catch (e) {
      console.error('Batch undo failed', e);
      this.notifications.showError(
        this.translate.instant('nautilus.errors.undoFailed', { count: entry.items.length })
      );
    }
  }

  async redoLastOperation(): Promise<void> {
    const stack = this._redoStack();
    if (stack.length === 0) return;

    const entry = stack[stack.length - 1];
    this._redoStack.set(stack.slice(0, -1));

    const transferItems = entry.items.map(item => ({
      srcRemote: item.srcRemote,
      srcPath: item.srcPath,
      name: item.name,
      isDir: item.isDir,
    }));

    try {
      // All items in a single undo/redo entry are moved/copied to the same destination folder.
      // We can use the parent path from the first item's destination.
      const firstItem = entry.items[0];
      const lastSlashIndex = firstItem.dstFullPath.lastIndexOf('/');
      const parentPath =
        lastSlashIndex > -1 ? firstItem.dstFullPath.substring(0, lastSlashIndex) : '';

      await this.remoteOps.transferItems(
        transferItems,
        firstItem.dstRemote,
        parentPath,
        entry.mode,
        ORIGINS.FILEMANAGER
      );

      this._undoStack.update(s => [...s.slice(-(this.MAX_UNDO_STACK - 1)), entry]);
      this.notifications.showSuccess(this.translate.instant('nautilus.notifications.redoComplete'));
    } catch (e) {
      console.error('Batch redo failed', e);
      this.notifications.showError(
        this.translate.instant('nautilus.errors.redoFailed', { count: entry.items.length })
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _normalizeRemote(remote: ExplorerRoot): string {
    return remote.isLocal ? remote.name : this.pathSelection.normalizeRemoteForRclone(remote.name);
  }
}
