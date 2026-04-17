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
    let failCount = 0;
    const succeededItems: UndoEntry['items'] = [];

    this.notifications.showInfo(
      this.translate.instant(
        mode === 'copy'
          ? 'nautilus.notifications.copyStarted'
          : 'nautilus.notifications.moveStarted',
        { count: items.length }
      )
    );

    for (const item of items) {
      try {
        const srcRemoteName = item.meta.remote ?? '';
        const normalizedSrc = this.pathSelection.normalizeRemoteForRclone(srcRemoteName);
        const dstFile = dstPath ? `${dstPath}/${item.entry.Name}` : item.entry.Name;
        const isDir = !!item.entry.IsDir;

        await this._dispatchFileOp(
          mode,
          normalizedSrc,
          item.entry.Path,
          normalizedDst,
          dstFile,
          isDir
        );

        succeededItems.push({
          srcRemote: normalizedSrc,
          srcPath: item.entry.Path,
          dstRemote: normalizedDst,
          dstFullPath: dstFile,
          isDir,
          name: item.entry.Name,
        });
      } catch (e) {
        console.error(`${mode} failed for ${item.entry.Path}`, e);
        failCount++;
      }
    }

    if (succeededItems.length > 0) {
      this._undoStack.update(s => [
        ...s.slice(-(this.MAX_UNDO_STACK - 1)),
        { mode, items: succeededItems },
      ]);
      this._redoStack.set([]);
    }

    if (failCount > 0) {
      this.notifications.showError(
        this.translate.instant(
          mode === 'copy' ? 'nautilus.errors.copyFailed' : 'nautilus.errors.moveFailed',
          { count: failCount }
        )
      );
    } else {
      this.notifications.showSuccess(this.translate.instant('nautilus.notifications.pasteStarted'));
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
    let failCount = 0;

    this.notifications.showInfo(
      this.translate.instant('nautilus.notifications.deleteStarted', { count: items.length })
    );

    for (const item of items) {
      try {
        if (item.entry.IsDir) {
          await this.remoteOps.purgeDirectory(
            normalizedRemote,
            item.entry.Path,
            ORIGINS.FILEMANAGER
          );
        } else {
          await this.remoteOps.deleteFile(normalizedRemote, item.entry.Path, ORIGINS.FILEMANAGER);
        }
      } catch (e) {
        console.error('Delete failed for', item.entry.Path, e);
        failCount++;
      }
    }

    if (failCount > 0) {
      this.notifications.showError(
        this.translate.instant('nautilus.errors.deleteFailed', {
          count: failCount,
          total: items.length,
        })
      );
    }

    return true; // signal caller to refresh
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
      await this.remoteOps.removeEmptyDirs(normalizedRemote, item.entry.Path, ORIGINS.FILEMANAGER);
      this.notifications.showInfo(
        this.translate.instant('nautilus.notifications.rmdirsStarted', { name: item.entry.Name })
      );
      return true;
    } catch (e) {
      this.notifications.showError(
        this.translate.instant('nautilus.errors.rmdirsFailed', {
          name: item.entry.Name,
          error: (e as Error).message,
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

    let failCount = 0;
    for (const item of entry.items) {
      try {
        if (entry.mode === 'copy') {
          if (item.isDir) {
            await this.remoteOps.purgeDirectory(
              item.dstRemote,
              item.dstFullPath,
              ORIGINS.FILEMANAGER
            );
          } else {
            await this.remoteOps.deleteFile(item.dstRemote, item.dstFullPath, ORIGINS.FILEMANAGER);
          }
        } else {
          await this._dispatchFileOp(
            'move',
            item.dstRemote,
            item.dstFullPath,
            item.srcRemote,
            item.srcPath,
            item.isDir
          );
        }
      } catch (e) {
        console.error('undo failed for', item.dstFullPath, e);
        failCount++;
      }
    }

    this._redoStack.update(s => [...s.slice(-(this.MAX_UNDO_STACK - 1)), entry]);

    if (failCount > 0) {
      this.notifications.showError(
        this.translate.instant('nautilus.errors.undoFailed', { count: failCount })
      );
    } else {
      this.notifications.showSuccess(this.translate.instant('nautilus.notifications.undoComplete'));
    }
  }

  async redoLastOperation(): Promise<void> {
    const stack = this._redoStack();
    if (stack.length === 0) return;

    const entry = stack[stack.length - 1];
    this._redoStack.set(stack.slice(0, -1));

    let failCount = 0;
    for (const item of entry.items) {
      try {
        await this._dispatchFileOp(
          entry.mode,
          item.srcRemote,
          item.srcPath,
          item.dstRemote,
          item.dstFullPath,
          item.isDir
        );
      } catch (e) {
        console.error('redo failed for', item.srcPath, e);
        failCount++;
      }
    }

    this._undoStack.update(s => [...s.slice(-(this.MAX_UNDO_STACK - 1)), entry]);

    if (failCount > 0) {
      this.notifications.showError(
        this.translate.instant('nautilus.errors.redoFailed', { count: failCount })
      );
    } else {
      this.notifications.showSuccess(this.translate.instant('nautilus.notifications.redoComplete'));
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async _dispatchFileOp(
    mode: 'copy' | 'move',
    srcRemote: string,
    srcPath: string,
    dstRemote: string,
    dstPath: string,
    isDir: boolean
  ): Promise<void> {
    if (mode === 'copy') {
      if (isDir) {
        await this.remoteOps.copyDirectory(
          srcRemote,
          srcPath,
          dstRemote,
          dstPath,
          ORIGINS.FILEMANAGER
        );
      } else {
        await this.remoteOps.copyFile(srcRemote, srcPath, dstRemote, dstPath, ORIGINS.FILEMANAGER);
      }
    } else {
      if (isDir) {
        await this.remoteOps.moveDirectory(
          srcRemote,
          srcPath,
          dstRemote,
          dstPath,
          ORIGINS.FILEMANAGER
        );
      } else {
        await this.remoteOps.moveFile(srcRemote, srcPath, dstRemote, dstPath, ORIGINS.FILEMANAGER);
      }
    }
  }

  private _normalizeRemote(remote: ExplorerRoot): string {
    return remote.isLocal ? remote.name : this.pathSelection.normalizeRemoteForRclone(remote.name);
  }
}
