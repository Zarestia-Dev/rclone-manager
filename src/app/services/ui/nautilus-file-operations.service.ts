import * as pathUtils from 'src/app/shared/utils/path.utils';
import { computed, inject, Injectable, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';

import { NotificationService } from 'src/app/services/ui/notification.service';
import { ModalService } from 'src/app/services/ui/modal.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import {
  RemoteFileOperationsService,
  WebUploadOutcome,
} from 'src/app/services/remote/remote-file-operations.service';
import { FileSystemService } from 'src/app/services/operations/file-system.service';
import { BackendTranslationService } from 'src/app/services/i18n/backend-translation.service';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { ExplorerRoot, FileBrowserItem, FsTransferItem, UploadTargets } from '@app/types';
import { isHeadlessMode } from 'src/app/services/infrastructure/platform/api-client.service';
import { findCopyName } from 'src/app/services/remote/utils/unique-name.util';
import type { TransferOptionValues } from 'src/app/shared/modals/transfer-options-modal/transfer-options-modal.component';
import type {
  ConflictChoices,
  ConflictEntry,
  TransferConflict,
} from 'src/app/shared/modals/transfer-conflict-modal/transfer-conflict-modal.component';

export interface UndoEntry {
  mode: 'copy' | 'move';
  /** The job that last ran this copy or move, so its row in the operations list can undo it. */
  jobid?: number;
  items: {
    remote: string;
    path: string;
    dstRemote: string;
    /** Where it landed, under the name it got there. */
    dstFullPath: string;
    isDir: boolean;
    /** Its own name, which a move puts back. */
    name: string;
  }[];
}

/** An item the conflict question looks at; one copied into its own folder is kept beside itself. */
type IncomingItem = ConflictEntry & { inPlace?: boolean };

/** The targets an upload sends for the items kept under another name or merged keeping files. */
function uploadTargets(choices: ConflictChoices): UploadTargets {
  const targets: UploadTargets = {};
  for (const [name, choice] of Object.entries(choices)) {
    if (choice.name || choice.existingFiles) {
      targets[name] = { name: choice.name, existingFiles: choice.existingFiles };
    }
  }
  return targets;
}

/** The path without the slashes that start or end it, so `/a/` and `a` compare equal. */
const trimSlashes = (path: string): string => path.replace(/^\/+|\/+$/g, '');

@Injectable()
export class NautilusFileOperationsService {
  private readonly MAX_UNDO_STACK = 20;

  private readonly translate = inject(TranslateService);
  private readonly modalService = inject(ModalService);
  private readonly remoteOps = inject(RemoteFileOperationsService);
  private readonly notifications = inject(NotificationService);
  private readonly pathService = inject(PathService);
  private readonly fileSystem = inject(FileSystemService);
  private readonly backendTranslation = inject(BackendTranslationService);
  private readonly appSettings = inject(AppSettingsService);
  private readonly remoteMetadata = inject(RemoteManagementService);

  readonly clipboardItems = signal<
    { remote: string; path: string; name: string; isDir: boolean }[]
  >([]);
  readonly clipboardMode = signal<'copy' | 'cut' | null>(null);
  readonly systemClipboardHasPaths = signal<boolean>(false);
  readonly hasClipboard = computed(
    () => this.clipboardItems().length > 0 || this.systemClipboardHasPaths()
  );
  readonly cutItemPaths = computed(() => {
    if (this.clipboardMode() !== 'cut') return new Set<string>();
    return new Set(this.clipboardItems().map(i => `${i.remote}:${i.path}`));
  });

  private readonly _undoStack = signal<UndoEntry[]>([]);
  private readonly _redoStack = signal<UndoEntry[]>([]);
  readonly canUndo = computed(() => this._undoStack().length > 0);
  readonly lastUndoJobId = computed(() => this._undoStack().at(-1)?.jobid);
  readonly canRedo = computed(() => this._redoStack().length > 0);

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

  async pasteItems(
    dstRemote: ExplorerRoot | null,
    dstPath: string,
    allRemotes: ExplorerRoot[]
  ): Promise<boolean> {
    const clipboardData = this.clipboardItems();
    const mode = this.clipboardMode();
    if (clipboardData.length > 0 && dstRemote && mode) {
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

    if (dstRemote) {
      return this.pasteSystemClipboard(dstRemote, dstPath);
    }

    return false;
  }

  /**
   * Uploads the local paths the system clipboard holds. Only the app does this: in a browser, the
   * paths name files on the browser's computer, which the server would look for on its own disk.
   * Files copied there reach the page as clipboard files, which the paste handler uploads.
   */
  async pasteSystemClipboard(
    dstRemote: ExplorerRoot | null,
    dstPath: string,
    preparsedText?: string
  ): Promise<boolean> {
    if (!dstRemote || isHeadlessMode()) return false;
    const text = preparsedText ?? (await this._readSystemClipboardText());
    const paths = this.parseClipboardPaths(text);
    if (paths.length > 0) {
      return this.uploadLocalPaths(dstRemote, dstPath, paths);
    }
    return false;
  }

  async checkSystemClipboard(): Promise<boolean> {
    if (isHeadlessMode()) return false;
    const text = await this._readSystemClipboardText();
    const hasPaths = this.parseClipboardPaths(text).length > 0;
    this.systemClipboardHasPaths.set(hasPaths);
    return hasPaths;
  }

  private _clipboardReader: (() => Promise<string>) | null = null;

  private async _readSystemClipboardText(): Promise<string> {
    try {
      if (!this._clipboardReader) {
        const mod = await import('@tauri-apps/plugin-clipboard-manager');
        this._clipboardReader = mod.readText;
      }
      return await this._clipboardReader();
    } catch (err) {
      console.debug('[NautilusFileOps] Could not read system clipboard:', err);
      return '';
    }
  }

  parseClipboardPaths(text: string): string[] {
    if (!text || typeof text !== 'string') return [];
    const lines = text
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => Boolean(l) && l !== 'copy' && l !== 'cut');
    const paths: string[] = [];

    for (let line of lines) {
      if (
        (line.startsWith('"') && line.endsWith('"')) ||
        (line.startsWith("'") && line.endsWith("'"))
      ) {
        line = line.slice(1, -1).trim();
      }

      if (line.startsWith('file://')) {
        try {
          const url = new URL(line);
          let pathname = decodeURIComponent(url.pathname);
          if (/^\/[a-zA-Z]:/.test(pathname)) {
            pathname = pathname.slice(1);
          }
          if (pathname) paths.push(pathname);
          continue;
        } catch {
          line = decodeURIComponent(line.replace(/^file:\/\/*/, '/'));
        }
      }

      if (line.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(line)) {
        paths.push(line);
      }
    }

    return Array.from(new Set(paths));
  }

  async performFileOperations(
    items: FileBrowserItem[],
    dstRemote: ExplorerRoot,
    dstPath: string,
    mode: 'copy' | 'move'
  ): Promise<void> {
    if (items.length === 0) return;

    const normalizedDst = this.pathService.normalizeRemoteForRclone(dstRemote.name);
    const sources = items.map(item => {
      const transfer: FsTransferItem = {
        remote: this.pathService.normalizeRemoteForRclone(item.meta.remote ?? ''),
        path: item.entry.Path,
        name: item.entry.Name,
        isDir: !!item.entry.IsDir,
      };
      const inPlace =
        transfer.remote === normalizedDst &&
        trimSlashes(pathUtils.getDirname(transfer.path)) === trimSlashes(dstPath);
      return { item, transfer, inPlace };
    });
    // rclone would copy a folder into itself without end, each pass copying what the last made.
    const destination = trimSlashes(dstPath);
    const intoItself = sources.find(({ transfer }) => {
      const source = trimSlashes(transfer.path);
      return (
        transfer.isDir &&
        transfer.remote === normalizedDst &&
        (destination === source || destination.startsWith(`${source}/`))
      );
    });
    if (intoItself) {
      this.notifications.showError(
        this.translate.instant('backendErrors.file.intoItself', {
          name: intoItself.item.entry.Name,
        })
      );
      return;
    }
    // Moving an item into the folder it is in leaves it where it is.
    const incoming = mode === 'move' ? sources.filter(source => !source.inPlace) : sources;
    if (incoming.length === 0) return;

    const choices = await this.resolveConflicts(
      mode,
      normalizedDst,
      dstPath,
      incoming.map(({ item, inPlace }) => ({
        name: item.entry.Name,
        isDir: !!item.entry.IsDir,
        size: item.entry.Size,
        modTime: item.entry.ModTime,
        inPlace,
      }))
    );
    if (!choices) return;
    const transferItems = incoming.flatMap(({ transfer }): FsTransferItem[] => {
      const choice = choices[transfer.name];
      if (choice?.action === 'skip') return [];
      return [
        { ...transfer, name: choice?.name ?? transfer.name, existingFiles: choice?.existingFiles },
      ];
    });
    if (transferItems.length === 0) return;
    // Undoing a replace or a merge would remove or move away what was there before.
    const undoable = !Object.values(choices).some(choice => choice.action === 'replace');

    // Within one remote rclone copies and moves on the server, where the options do not apply.
    const options = transferItems.some(item => item.remote !== normalizedDst)
      ? await this.pickTransferOptions(mode, transferItems.length, normalizedDst + dstPath, [
          normalizedDst,
          ...transferItems.map(item => item.remote),
        ])
      : undefined;
    if (options === null) return;

    this.notifications.showInfo(
      this.translate.instant(
        mode === 'copy'
          ? 'nautilus.notifications.copyStarted'
          : 'nautilus.notifications.moveStarted',
        { count: transferItems.length }
      )
    );

    try {
      const jobid = await this.remoteOps.transferItems(
        transferItems,
        normalizedDst,
        dstPath,
        mode,
        'filemanager',
        undefined,
        undefined,
        options
      );

      if (undoable) {
        const succeededItems: UndoEntry['items'] = transferItems.map(item => ({
          remote: item.remote,
          path: item.path,
          dstRemote: normalizedDst,
          dstFullPath: pathUtils.joinPath(dstPath, item.name),
          isDir: item.isDir,
          name: pathUtils.getFilename(item.path),
        }));
        this._undoStack.update(s => [
          ...s.slice(-(this.MAX_UNDO_STACK - 1)),
          { mode, jobid, items: succeededItems },
        ]);
      } else {
        // An earlier entry may name a file this one replaced.
        this._undoStack.set([]);
      }
      this._redoStack.set([]);
    } catch (e) {
      console.error(`${mode} batch failed`, e);
      this.notifications.showError(
        this.backendTranslation.translateBackendMessage(e) ||
          this.translate.instant(
            mode === 'copy' ? 'nautilus.errors.copyFailed' : 'nautilus.errors.moveFailed',
            { count: transferItems.length }
          )
      );
    }
  }

  /**
   * How the incoming items land where the destination holds items of the same name: a choice for
   * each by its own name, or null when the user cancels. An item copied into its own folder is
   * kept beside itself without a question. A destination that cannot be listed is left to rclone.
   * Names are compared as the destination does: Dropbox, OneDrive and the local disk of Windows or
   * macOS hold one of `Report.pdf` and `report.pdf` (rclone's `CaseInsensitive`, read from the
   * features the file browser keeps for each remote).
   */
  private async resolveConflicts(
    operation: 'copy' | 'move' | 'upload',
    dstFs: string,
    dstPath: string,
    incoming: IncomingItem[]
  ): Promise<ConflictChoices | null> {
    let existing;
    let caseInsensitive: boolean;
    try {
      const [listing, features] = await Promise.all([
        this.remoteOps.getRemotePaths(dstFs, dstPath === '/' ? '' : dstPath, {}, 'filemanager'),
        this.remoteMetadata.getFeatures(dstFs, { source: 'filemanager' }),
      ]);
      existing = listing.list ?? [];
      caseInsensitive = !!features['CaseInsensitive'];
    } catch (error) {
      console.warn('Cannot list the destination to look for name conflicts', error);
      return {};
    }
    const fold = (name: string): string => (caseInsensitive ? name.toLowerCase() : name);
    const there = new Map(existing.map(entry => [fold(entry.Name), entry]));
    const taken = new Set([...existing.map(entry => entry.Name), ...incoming.map(e => e.name)]);
    const choices: ConflictChoices = {};
    const conflicts: TransferConflict[] = [];
    for (const { inPlace, ...entry } of incoming) {
      if (inPlace) {
        const name = findCopyName(entry.name, entry.isDir, taken, caseInsensitive);
        taken.add(name);
        choices[entry.name] = { action: 'keepBoth', name };
        continue;
      }
      const other = there.get(fold(entry.name));
      if (other) {
        conflicts.push({
          incoming: entry,
          existing: {
            name: other.Name,
            isDir: other.IsDir,
            size: other.Size,
            modTime: other.ModTime,
          },
        });
      }
    }
    if (conflicts.length === 0) return choices;

    const answer = await firstValueFrom(
      this.modalService
        .openTransferConflicts({
          operation,
          destination: dstFs + dstPath,
          total: incoming.length,
          conflicts,
          taken: [...taken],
          caseInsensitive,
        })
        .afterClosed()
    );
    return answer ? { ...choices, ...answer } : null;
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
      'common.delete',
      'common.cancel',
      { icon: 'trash', color: 'warn' }
    );
    if (!confirmed) return false;

    this.notifications.showInfo(
      this.translate.instant('nautilus.notifications.deleteStarted', { count: items.length })
    );

    const deleteItems = items.map(item => ({
      remote: this.pathService.normalizeExplorerRoot(remote),
      path: item.entry.Path,
      isDir: !!item.entry.IsDir,
    }));

    try {
      await this.remoteOps.deleteItems(deleteItems, 'filemanager');
      return true;
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
    const normalizedRemote = this.pathService.normalizeExplorerRoot(remote);

    const ref = await this.notifications.openInput<string>({
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

      const newPath = pathUtils.joinPath(this.pathService.getParentPath(item.entry.Path), newName);

      await this.remoteOps.rename(
        normalizedRemote,
        item.entry.Path,
        newPath,
        !!item.entry.IsDir,
        'filemanager'
      );

      this.notifications.showSuccess(
        this.translate.instant('nautilus.notifications.renameStarted')
      );
      return true;
    } catch (e) {
      this.notifications.showError(
        this.translate.instant('nautilus.errors.renameFailed', {
          name: item.entry.Name,
          error: (e as Error).message || String(e),
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

    const normalizedRemote = this.pathService.normalizeRemoteForRclone(remote.name);
    try {
      this.notifications.showInfo(
        this.translate.instant('nautilus.notifications.rmdirsStarted', { name: item.entry.Name })
      );
      await this.remoteOps.removeEmptyDirs(normalizedRemote, item.entry.Path, 'filemanager');
      return true;
    } catch (e) {
      this.notifications.showError(
        this.translate.instant('nautilus.errors.rmdirsFailed', {
          name: item.entry.Name,
          error: (e as Error).message || String(e),
        })
      );
      return false;
    }
  }

  async undoLastOperation(): Promise<void> {
    const stack = this._undoStack();
    if (stack.length === 0) return;

    const entry = stack[stack.length - 1];

    try {
      if (entry.mode === 'copy') {
        const itemsToDelete = entry.items.map(item => ({
          remote: item.dstRemote,
          path: item.dstFullPath,
          isDir: item.isDir,
        }));
        await this.remoteOps.deleteItems(itemsToDelete, 'filemanager');
      } else {
        const groups = this._groupTransferItems(entry.items, item => ({
          sourceRemote: item.dstRemote,
          sourcePath: item.dstFullPath,
          dstRemote: item.remote,
          dstPath: this.pathService.getParentPath(item.path),
          name: item.name,
        }));

        for (const group of groups.values()) {
          await this.remoteOps.transferItems(
            group.items,
            group.dstRemote,
            group.dstPath,
            'move',
            'filemanager'
          );
        }
      }

      this._undoStack.set(stack.slice(0, -1));
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

    try {
      const groups = this._groupTransferItems(entry.items, item => ({
        sourceRemote: item.remote,
        sourcePath: item.path,
        dstRemote: item.dstRemote,
        dstPath: this.pathService.getParentPath(item.dstFullPath),
        name: pathUtils.getFilename(item.dstFullPath),
      }));

      let jobid = entry.jobid;
      for (const group of groups.values()) {
        jobid = await this.remoteOps.transferItems(
          group.items,
          group.dstRemote,
          group.dstPath,
          entry.mode,
          'filemanager'
        );
      }

      this._redoStack.set(stack.slice(0, -1));
      this._undoStack.update(s => [...s.slice(-(this.MAX_UNDO_STACK - 1)), { ...entry, jobid }]);
      this.notifications.showSuccess(this.translate.instant('nautilus.notifications.redoComplete'));
    } catch (e) {
      console.error('Batch redo failed', e);
      this.notifications.showError(
        this.translate.instant('nautilus.errors.redoFailed', { count: entry.items.length })
      );
    }
  }

  private _groupTransferItems(
    items: UndoEntry['items'],
    getDstInfo: (item: UndoEntry['items'][number]) => {
      sourceRemote: string;
      sourcePath: string;
      dstRemote: string;
      dstPath: string;
      /** The name it gets where it goes. */
      name: string;
    }
  ): Map<
    string,
    {
      dstRemote: string;
      dstPath: string;
      items: { remote: string; path: string; name: string; isDir: boolean }[];
    }
  > {
    const groups = new Map<
      string,
      {
        dstRemote: string;
        dstPath: string;
        items: { remote: string; path: string; name: string; isDir: boolean }[];
      }
    >();

    for (const item of items) {
      const { sourceRemote, sourcePath, dstRemote, dstPath, name } = getDstInfo(item);
      const key = `${dstRemote}:${dstPath}`;

      let group = groups.get(key);
      if (!group) {
        group = { dstRemote, dstPath, items: [] };
        groups.set(key, group);
      }

      group.items.push({
        remote: sourceRemote,
        path: sourcePath,
        name,
        isDir: item.isDir,
      });
    }

    return groups;
  }

  async uploadExternalFiles(remote: ExplorerRoot, currentPath: string): Promise<boolean> {
    try {
      const paths = await this.fileSystem.selectFilesForUpload();
      if (!paths.length) return false;
      try {
        return await this.uploadLocalPaths(remote, currentPath, paths);
      } finally {
        this.fileSystem.releaseUploadPaths(paths);
      }
    } catch (err) {
      console.error('Failed to select files', err);
      this.notifications.showError(this.translate.instant('nautilus.errors.externalDropFailed'));
      return false;
    }
  }

  async uploadExternalFolder(remote: ExplorerRoot, currentPath: string): Promise<boolean> {
    try {
      const folderPath = await this.fileSystem.selectFolderForUpload();
      if (!folderPath) return false;
      try {
        return await this.uploadLocalPaths(remote, currentPath, [folderPath]);
      } finally {
        this.fileSystem.releaseUploadPaths([folderPath]);
      }
    } catch (err) {
      console.error('Failed to select folder', err);
      this.notifications.showError(this.translate.instant('nautilus.errors.externalDropFailed'));
      return false;
    }
  }

  async uploadWebFiles(
    remote: ExplorerRoot,
    currentPath: string,
    fileList: FileList
  ): Promise<boolean> {
    return this.uploadWebEntries(
      remote,
      currentPath,
      Array.from(fileList).map(file => ({
        file,
        relativePath: file.webkitRelativePath || file.name,
      }))
    );
  }

  /** Shared upload orchestration for browser file pickers and external drops. */
  async uploadWebEntries(
    remote: ExplorerRoot,
    currentPath: string,
    files: { file: File; relativePath: string }[],
    emptyDirectories: string[] = []
  ): Promise<boolean> {
    if (!files.length && !emptyDirectories.length) return false;
    const normalized = this.pathService.normalizeExplorerRoot(remote);

    // What lands in the destination folder itself: a picked file, or the folder a path starts in.
    const topName = (path: string): string => path.split('/')[0];
    const picked = new Map<string, ConflictEntry>();
    for (const { file, relativePath } of files) {
      const path = relativePath || file.name;
      const name = topName(path);
      if (picked.has(name)) continue;
      picked.set(
        name,
        path === name
          ? {
              name,
              isDir: false,
              size: file.size,
              modTime: new Date(file.lastModified).toISOString(),
            }
          : { name, isDir: true }
      );
    }
    for (const dir of emptyDirectories) {
      const name = topName(dir);
      if (name && !picked.has(name)) picked.set(name, { name, isDir: true });
    }
    const choices = await this.resolveConflicts('upload', normalized, currentPath, [
      ...picked.values(),
    ]);
    if (!choices) return false;
    const sent = (path: string): boolean => choices[topName(path)]?.action !== 'skip';
    const sendFiles = files.filter(({ file, relativePath }) => sent(relativePath || file.name));
    const sendDirs = emptyDirectories.filter(sent);
    if (!sendFiles.length && !sendDirs.length) return false;

    const options = await this.pickTransferOptions(
      'upload',
      sendFiles.length || sendDirs.length,
      normalized + currentPath,
      [normalized]
    );
    if (options === null) return false;

    return this.reportWebUpload(
      () =>
        this.remoteOps.uploadWebFilesBatch(
          normalized,
          currentPath,
          sendFiles,
          'filemanager',
          sendDirs,
          options,
          uploadTargets(choices)
        ),
      { files: sendFiles.length, items: sendFiles.length || sendDirs.length }
    );
  }

  /**
   * Continues a paused browser upload: with `picked`, the files the user selected again, which
   * must include at least one of those it still needs.
   */
  async resumeWebUpload(
    group: string,
    picked?: { file: File; relativePath: string }[]
  ): Promise<boolean> {
    const upload = this.remoteOps.pendingWebUploads().find(item => item.group === group);
    if (!upload) return false;
    if (picked && this.remoteOps.attachWebUploadFiles(group, picked) === 0) {
      this.notifications.showError(
        this.translate.instant('nautilus.notifications.uploadFilesNotInUpload')
      );
      return false;
    }
    return this.reportWebUpload(
      () => this.remoteOps.resumeWebUpload(group),
      { files: upload.files, items: upload.files },
      group
    );
  }

  /** Reports how a browser upload of `count.files` files (`count.items` with folders) ended. */
  private async reportWebUpload(
    upload: () => Promise<WebUploadOutcome>,
    count: { files: number; items: number },
    group?: string
  ): Promise<boolean> {
    let outcome: WebUploadOutcome;
    try {
      outcome = await upload();
    } catch (error) {
      console.error('Browser upload failed', error);
      this.notifications.showError(
        this.backendTranslation.translateBackendMessage(error) ||
          this.translate.instant('nautilus.notifications.uploadFailed', { count: count.items })
      );
      return false;
    }
    if (outcome === 'paused') {
      const missing =
        this.remoteOps.pendingWebUploads().find(item => item.group === group)?.paused?.missing ?? 0;
      this.notifications.showWarning(
        missing
          ? this.translate.instant('nautilus.notifications.uploadFilesStillMissing', {
              count: missing,
            })
          : this.translate.instant('nautilus.notifications.uploadInterrupted')
      );
    }
    // A transfer still running is followed in the operations panel, like any other job.
    if (outcome === 'finished' && count.files > 0) {
      this.notifications.showSuccess(
        this.translate.instant('nautilus.notifications.uploadSuccess', { count: count.files })
      );
    }
    return outcome === 'finished' || outcome === 'running';
  }

  async openNewFolderDialog(
    remote: ExplorerRoot,
    currentPath: string,
    existingNames: string[]
  ): Promise<boolean> {
    const normalizedRemote = this.pathService.normalizeExplorerRoot(remote);

    const ref = await this.notifications.openInput<string>({
      title: this.translate.instant('nautilus.modals.newFolder.title'),
      label: this.translate.instant('nautilus.modals.newFolder.label'),
      icon: 'folder',
      placeholder: this.translate.instant('nautilus.modals.newFolder.placeholder'),
      existingNames,
    });

    let folderName: string | undefined;
    try {
      folderName = await firstValueFrom(ref.afterClosed());
      if (!folderName) return false;

      const newPath = pathUtils.joinPath(currentPath, folderName);
      await this.remoteOps.makeDirectory(normalizedRemote, newPath, 'filemanager');
      return true;
    } catch (err) {
      console.error('[NautilusFileOps] Failed to create folder:', err);
      const errMsg = (err as Error)?.message || String(err);
      this.notifications.showError(
        this.translate.instant('nautilus.errors.createFolderFailed', {
          name: folderName || '',
          error: errMsg,
        })
      );
      return false;
    }
  }

  async openCopyUrlDialog(remote: ExplorerRoot, currentPath: string): Promise<boolean> {
    const normalizedRemote = this.pathService.normalizeExplorerRoot(remote);
    const destBasePath = pathUtils.joinPath(normalizedRemote, currentPath);

    const ref = await this.notifications.openInput<{ url?: string; filename?: string }>({
      title: this.translate.instant('nautilus.modals.copyUrl.title'),
      icon: 'download',
      createLabel: this.translate.instant('nautilus.modals.copyUrl.confirm'),
      destinationPath: destBasePath,
      showUrlPreview: true,
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
      const targetPath =
        !autoFilename && targetFilename
          ? pathUtils.joinPath(currentPath, targetFilename)
          : currentPath;

      this.notifications.showInfo(this.translate.instant('nautilus.notifications.copyUrlStarted'));

      await this.remoteOps.copyUrl(
        normalizedRemote,
        targetPath,
        url.trim(),
        autoFilename,
        'filemanager'
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

  async openArchiveCreateDialog(
    remote: ExplorerRoot,
    items: FileBrowserItem[],
    currentPath: string
  ): Promise<boolean> {
    if (items.length === 0) return false;

    const firstItem = items[0];
    const defaultName = items.length === 1 ? `${firstItem.entry.Name}.zip` : 'archive.zip';

    const ref = this.modalService.openArchiveCreate({ items, defaultName });
    const result = (await firstValueFrom(ref.afterClosed())) as {
      filename: string;
      format: string;
      prefix: string;
      fullPath: boolean;
    } | null;
    if (!result) return false;

    const { filename, format, prefix, fullPath } = result;
    const isLocal = remote.isLocal;
    const baseName = remote.name;

    try {
      const sourcePath = items.length === 1 ? firstItem.entry.Path : currentPath;
      const source = isLocal
        ? pathUtils.joinPath(baseName, sourcePath)
        : `${this.pathService.normalizeRemoteForRclone(baseName)}${sourcePath}`;

      const destinationPath = pathUtils.joinPath(currentPath, filename);
      const destination = isLocal
        ? pathUtils.joinPath(baseName, destinationPath)
        : `${this.pathService.normalizeRemoteForRclone(baseName)}${destinationPath}`;

      const include = items.length > 1 ? items.map(i => i.entry.Name) : undefined;

      this.notifications.showInfo(
        this.translate.instant('nautilus.notifications.archiveCreateStarted')
      );

      await this.remoteOps.archiveCreate(source, destination, format, prefix, fullPath, include);
      return true;
    } catch (e) {
      this.notifications.showError(
        this.translate.instant('nautilus.errors.archiveCreateFailed', {
          error: (e as Error).message,
        })
      );
      return false;
    }
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

  /**
   * The options a transfer runs with, when the preferences ask for them on each transfer: those
   * set in the dialog, or null when the user cancels. Otherwise undefined, which leaves the file
   * browser's default to the backend, where Send To gets it too. `remotes` are the remotes the
   * transfer touches, each of which can get options of its own.
   */
  private async pickTransferOptions(
    operation: 'upload' | 'copy' | 'move',
    count: number,
    destination: string,
    remotes: string[]
  ): Promise<TransferOptionValues | null | undefined> {
    if (!(await this.appSettings.getSettingValue<boolean>('nautilus.ask_transfer_options'))) {
      return undefined;
    }
    const values =
      (await this.appSettings.getSettingValue<TransferOptionValues>('nautilus.transfer_options')) ??
      {};
    const choice = await firstValueFrom(
      this.modalService
        .openTransferOptions({
          mode: 'transfer',
          operation,
          count,
          destination,
          remotes: [...new Set(remotes.map(remote => remote.replace(/:+$/, '')).filter(Boolean))],
          values,
        })
        .afterClosed()
    );
    return choice ?? null;
  }

  async uploadLocalPaths(
    remote: ExplorerRoot,
    currentPath: string,
    paths: string[]
  ): Promise<boolean> {
    if (!paths.length) return false;
    const normalized = this.pathService.normalizeExplorerRoot(remote);
    try {
      const picked = await this.remoteOps.localPathInfo(paths);
      const choices = await this.resolveConflicts('upload', normalized, currentPath, picked);
      if (!choices) return false;
      const sendPaths = paths.filter((_, i) => choices[picked[i].name]?.action !== 'skip');
      if (!sendPaths.length) return false;

      const options = await this.pickTransferOptions(
        'upload',
        sendPaths.length,
        normalized + currentPath,
        [normalized]
      );
      if (options === null) return false;
      // Id 0 means every file was kept as it was there: the upload still succeeded.
      await this.remoteOps.uploadLocalDropPaths(
        normalized,
        currentPath,
        sendPaths,
        'filemanager',
        undefined,
        options,
        uploadTargets(choices)
      );
      return true;
    } catch (err) {
      console.error('Local upload failed', err);
      this.notifications.showError(
        this.backendTranslation.translateBackendMessage(err) ||
          this.translate.instant('nautilus.errors.externalDropFailed')
      );
      return false;
    }
  }
}
