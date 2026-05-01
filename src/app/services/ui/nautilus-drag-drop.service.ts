import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import {
  isHeadlessMode,
  NotificationService,
  PathSelectionService,
  RemoteFileOperationsService,
} from '@app/services';
import { ExplorerRoot, FileBrowserItem, ORIGINS } from '@app/types';
import { NautilusFileOperationsService } from 'src/app/services/ui/nautilus-file-operations.service';
import { getCurrentWindow } from '@tauri-apps/api/window';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const NAUTILUS_DRAG_MIME_TYPE = 'application/nautilus-files';

export interface NautilusDragPayload {
  items: FileBrowserItem[];
  sourcePaneIndex: 0 | 1;
}

export interface DragDropContext {
  activeRemote: ExplorerRoot | null;
  activePath: string;
  panes: [
    { remote: ExplorerRoot | null; path: string },
    { remote: ExplorerRoot | null; path: string },
  ];
  files: FileBrowserItem[];
  filesRight: FileBrowserItem[];
  activePaneIndex: 0 | 1;
  pathSegments: { name: string; path: string }[];
  tabs: { id: number; left: { remote: ExplorerRoot | null; path: string } }[];
  allRemotesLookup: ExplorerRoot[];
  bookmarks: FileBrowserItem[];
}

export interface DragDropCallbacks {
  getContext: () => DragDropContext;
  navigateTo: (item: FileBrowserItem) => void;
  navigateToSegment: (index: number) => void;
  updatePath: (path: string) => void;
  switchTab: (index: number) => void;
  switchPane: (index: 0 | 1) => void;
  selectStarred: () => void;
  selectRemote: (remote: ExplorerRoot) => void;
  openBookmark: (bm: FileBrowserItem) => void;
  toggleStar: (item: FileBrowserItem) => void;
  isStarred: (item: FileBrowserItem) => boolean;
  toggleBookmark: (item: FileBrowserItem) => void;
  refresh: () => void;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface HitResult {
  folder: FileBrowserItem | null;
  segmentIndex: number | null;
  tabIndex: number | null;
  sidebarItem: string | null;
  paneIndex: number | null;
}

const HOVER_OPEN_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Owns all drag-and-drop state and logic for the Nautilus file manager.
 */
@Injectable()
export class NautilusDragDropService {
  private readonly remoteOps = inject(RemoteFileOperationsService);
  private readonly pathSel = inject(PathSelectionService);
  private readonly notifications = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly fileOps = inject(NautilusFileOperationsService);
  private readonly destroyRef = inject(DestroyRef);

  // ---- Public state ----
  readonly isDragging = signal(false);
  readonly hoveredFolder = signal<FileBrowserItem | null>(null);
  readonly hoveredFolderPaneIndex = signal<number | null>(null);
  readonly hoveredSegmentIndex = signal<number | null>(null);
  readonly hoveredTabIndex = signal<number | null>(null);
  readonly hoveredSidebarItem = signal<string | null>(null);

  // ---- Private internals ----
  private _items: FileBrowserItem[] = [];
  private _counter = 0;
  private _lastHitKey = '';
  private _hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private _hoverKey = '';
  private _cb!: DragDropCallbacks;

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  register(cb: DragDropCallbacks): void {
    this._cb = cb;
  }

  /**
   * Attaches the Tauri native-drop listener; no-op in browser.
   *
   * This is the ONLY upload path for OS-level file drops in Tauri. It passes
   * local filesystem paths directly to Rust, which reads them natively —
   * no bytes flow over IPC.
   */
  async setupDesktopNativeDropListener(): Promise<void> {
    if (isHeadlessMode()) return;
    try {
      const unlisten = await getCurrentWindow().onDragDropEvent(async event => {
        if (event.payload.type !== 'drop') return;
        const target = this._resolveDropTargetFromPoint(
          event.payload.position.x,
          event.payload.position.y
        );
        if (!target.remote || event.payload.paths.length === 0) return;

        const normalized = this._normalizeRemote(target.remote);
        try {
          const batchId = await this.remoteOps.uploadLocalDropPaths(
            normalized,
            target.path,
            event.payload.paths,
            ORIGINS.FILEMANAGER
          );

          if (batchId) {
            this.notifications.showInfo(
              this.translate.instant('nautilus.notifications.uploadStarted', {
                count: event.payload.paths.length,
              })
            );
          }
        } catch (err) {
          console.error('[Nautilus] Native drop upload failed', err);
          this.notifications.showError(
            this.translate.instant('nautilus.errors.externalDropFailed')
          );
        }
      });
      this.destroyRef.onDestroy(() => unlisten());
    } catch (err) {
      console.warn('[Nautilus] Desktop drag-drop listener setup failed', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Drag lifecycle
  // ---------------------------------------------------------------------------

  startDrag(event: DragEvent, items: FileBrowserItem[], paneIndex: 0 | 1): void {
    this.isDragging.set(true);
    this._lastHitKey = '';
    this._items = items;

    const payload: NautilusDragPayload = { items, sourcePaneIndex: paneIndex };
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'copyMove';
      event.dataTransfer.setData(NAUTILUS_DRAG_MIME_TYPE, JSON.stringify(payload));
    }
  }

  endDrag(): void {
    this.isDragging.set(false);
    this._counter = 0;
    this._lastHitKey = '';
    this._clearHoverTimer();
    this._items = [];
    this.hoveredFolder.set(null);
    this.hoveredFolderPaneIndex.set(null);
    this.hoveredSegmentIndex.set(null);
    this.hoveredTabIndex.set(null);
    this.hoveredSidebarItem.set(null);
  }

  // ---------------------------------------------------------------------------
  // Container-level events
  // ---------------------------------------------------------------------------

  onDragOver(event: DragEvent): void {
    if (event.dataTransfer?.types.includes('application/x-nautilus-tab')) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this._onMove({ x: event.clientX, y: event.clientY });
  }

  onContainerDragEnter(_event: DragEvent): void {
    this._counter++;
    if (this._counter === 1 && !this.isDragging()) this.isDragging.set(true);
  }

  onContainerDragLeave(_event: DragEvent): void {
    this._counter--;
    if (this._counter <= 0) {
      this._counter = 0;
      if (this._items.length === 0) this.endDrag();
    }
  }

  onContainerDrop(event: DragEvent): void {
    event.preventDefault();
    const ctx = this._cb.getContext();

    if (
      !isHeadlessMode() &&
      ctx.activeRemote &&
      event.dataTransfer &&
      this._hasExternalFiles(event)
    ) {
      const fsEntries = this._snapshotEntries(event.dataTransfer.items);
      void this._processExternalDrop(
        event,
        { remote: ctx.activeRemote, path: ctx.activePath },
        fsEntries
      );
    }

    this._counter = 0;
    if (this._items.length === 0) this.endDrag();
  }

  // ---------------------------------------------------------------------------
  // Named drop targets
  // ---------------------------------------------------------------------------

  dropToStarred(event: DragEvent): void {
    event.stopPropagation();
    const data = event.dataTransfer?.getData(NAUTILUS_DRAG_MIME_TYPE);
    if (!data) return;
    const { items } = JSON.parse(data) as NautilusDragPayload;
    items.forEach(item => {
      if (!this._cb.isStarred(item)) this._cb.toggleStar(item);
    });
  }

  dropToLocal(event: DragEvent): void {
    event.stopPropagation();
    const data = event.dataTransfer?.getData(NAUTILUS_DRAG_MIME_TYPE);
    if (!data) return;
    const { items } = JSON.parse(data) as NautilusDragPayload;
    items.forEach(item => {
      if (item.entry.IsDir) this._cb.toggleBookmark(item);
    });
  }

  async dropToBookmark(event: DragEvent, bookmark: FileBrowserItem): Promise<void> {
    event.stopPropagation();
    const { allRemotesLookup } = this._cb.getContext();
    const targetRemote =
      allRemotesLookup.find(
        r =>
          this.pathSel.normalizeRemoteName(r.name) ===
          this.pathSel.normalizeRemoteName(bookmark.meta.remote)
      ) ?? null;
    const fsEntries = event.dataTransfer ? this._snapshotEntries(event.dataTransfer.items) : [];
    await this._processDrop(event, { remote: targetRemote, path: bookmark.entry.Path }, fsEntries);
  }

  async dropToRemote(event: DragEvent, targetRemote: ExplorerRoot): Promise<void> {
    event.stopPropagation();
    const fsEntries = event.dataTransfer ? this._snapshotEntries(event.dataTransfer.items) : [];
    await this._processDrop(event, { remote: targetRemote, path: '' }, fsEntries);
  }

  async dropToCurrentDirectory(event: DragEvent, paneIndex: number): Promise<void> {
    event.stopPropagation();
    const pIdx = paneIndex as 0 | 1;
    const ctx = this._cb.getContext();
    const targetRemote = ctx.panes[pIdx].remote;
    if (!targetRemote) return;

    const resolved = this._resolveDropHit({ x: event.clientX, y: event.clientY }, ctx);
    const folder = resolved.folder ?? this.hoveredFolder();
    const segIdx = resolved.segmentIndex ?? this.hoveredSegmentIndex();
    const tabIdx = resolved.tabIndex ?? this.hoveredTabIndex();
    const fsEntries = event.dataTransfer ? this._snapshotEntries(event.dataTransfer.items) : [];

    if (tabIdx !== null) {
      const tab = ctx.tabs[tabIdx];
      if (tab?.left.remote) {
        await this._processDrop(event, { remote: tab.left.remote, path: tab.left.path }, fsEntries);
      }
      return;
    }

    const targetPath = folder
      ? folder.entry.Path
      : segIdx !== null
        ? segIdx < 0
          ? ''
          : (ctx.pathSegments[segIdx]?.path ?? '')
        : ctx.panes[pIdx].path;

    await this._processDrop(event, { remote: targetRemote, path: targetPath }, fsEntries);
  }

  async dropToSegment(event: DragEvent, segIdx: number): Promise<void> {
    event.stopPropagation();
    const ctx = this._cb.getContext();
    const pIdx = ctx.activePaneIndex;
    const targetRemote = ctx.panes[pIdx].remote;
    if (!targetRemote) return;
    const targetPath = segIdx < 0 ? '' : (ctx.pathSegments[segIdx]?.path ?? '');
    if (targetPath === ctx.panes[pIdx].path) return;
    const fsEntries = event.dataTransfer ? this._snapshotEntries(event.dataTransfer.items) : [];
    await this._processDrop(event, { remote: targetRemote, path: targetPath }, fsEntries);
  }

  // ---------------------------------------------------------------------------
  // Private: hit resolution & hover-open timer
  // ---------------------------------------------------------------------------

  private _onMove(point: { x: number; y: number }): void {
    const ctx = this._cb.getContext();
    const hit = this._resolveDropHit(point, ctx);
    const hitKey = `${hit.folder?.entry.Path ?? 'null'}:${hit.segmentIndex ?? 'null'}:${hit.tabIndex ?? 'null'}:${hit.sidebarItem ?? 'null'}`;
    if (hitKey === this._lastHitKey) return;
    this._lastHitKey = hitKey;

    this.hoveredFolder.set(hit.folder);
    this.hoveredFolderPaneIndex.set(hit.folder ? hit.paneIndex : null);
    this.hoveredSegmentIndex.set(hit.segmentIndex);
    this.hoveredTabIndex.set(hit.tabIndex);
    this.hoveredSidebarItem.set(hit.sidebarItem);

    if (hit.paneIndex !== null && hit.paneIndex !== ctx.activePaneIndex) {
      this._cb.switchPane(hit.paneIndex as 0 | 1);
    }

    this._scheduleHoverOpen(hitKey, hit, ctx);
  }

  private _resolveDropHit(point: { x: number; y: number }, ctx: DragDropContext): HitResult {
    const el = document.elementFromPoint(point.x, point.y);
    if (!el)
      return {
        folder: null,
        segmentIndex: null,
        tabIndex: null,
        sidebarItem: null,
        paneIndex: null,
      };

    const folderTarget = el.closest('[data-folder-path]');
    const segmentTarget = el.closest('[data-segment-index]');
    const tabTarget = el.closest('[data-tab-index]');
    const sidebarStarred = el.closest('[data-sidebar-starred]');
    const sidebarBookmarksHeader = el.closest('[data-sidebar-bookmarks-header]');
    const sidebarBookmark = el.closest('[data-sidebar-bookmark-path]');
    const sidebarRemote = el.closest('[data-sidebar-remote-name]');
    const paneTarget = el.closest('[data-pane-index]');
    const paneIndexRaw = paneTarget?.getAttribute('data-pane-index');
    const targetPaneIndex = paneIndexRaw != null ? parseInt(paneIndexRaw, 10) : ctx.activePaneIndex;

    const currentFiles = targetPaneIndex === 0 ? ctx.files : ctx.filesRight;
    const folder = folderTarget
      ? (currentFiles.find(f => f.entry.Path === folderTarget.getAttribute('data-folder-path')) ??
        null)
      : null;

    let sidebarItem: string | null = null;
    if (sidebarStarred) sidebarItem = 'starred';
    else if (sidebarBookmarksHeader) sidebarItem = 'bookmarks-header';
    else if (sidebarBookmark)
      sidebarItem = 'bookmark:' + sidebarBookmark.getAttribute('data-sidebar-bookmark-path');
    else if (sidebarRemote)
      sidebarItem = 'remote:' + sidebarRemote.getAttribute('data-sidebar-remote-name');

    return {
      folder,
      segmentIndex: segmentTarget
        ? parseInt(segmentTarget.getAttribute('data-segment-index')!, 10)
        : null,
      tabIndex: tabTarget ? parseInt(tabTarget.getAttribute('data-tab-index')!, 10) : null,
      sidebarItem,
      paneIndex: paneTarget ? parseInt(paneTarget.getAttribute('data-pane-index')!, 10) : null,
    };
  }

  private _resolveDropTargetFromPoint(
    x: number,
    y: number
  ): { remote: ExplorerRoot | null; path: string } {
    const ctx = this._cb.getContext();
    const resolved = this._resolveDropHit({ x, y }, ctx);
    const folder = resolved.folder ?? this.hoveredFolder();
    const segIdx = resolved.segmentIndex ?? this.hoveredSegmentIndex();
    const tabIdx = resolved.tabIndex ?? this.hoveredTabIndex();

    if (tabIdx !== null) {
      const tab = ctx.tabs[tabIdx];
      if (tab?.left.remote) return { remote: tab.left.remote, path: tab.left.path };
    }

    const pIdx = (resolved.paneIndex as 0 | 1 | null) ?? ctx.activePaneIndex;
    const pane = ctx.panes[pIdx];
    if (!pane.remote) return { remote: null, path: '' };

    if (folder?.entry.IsDir) {
      const folderRemote =
        ctx.allRemotesLookup.find(
          r =>
            this.pathSel.normalizeRemoteName(r.name) ===
            this.pathSel.normalizeRemoteName(folder.meta.remote)
        ) ?? pane.remote;
      return { remote: folderRemote, path: folder.entry.Path };
    }

    if (segIdx !== null) {
      return {
        remote: pane.remote,
        path: segIdx < 0 ? '' : (ctx.pathSegments[segIdx]?.path ?? ''),
      };
    }

    return { remote: pane.remote, path: pane.path };
  }

  private _clearHoverTimer(): void {
    if (this._hoverTimer !== null) {
      clearTimeout(this._hoverTimer);
      this._hoverTimer = null;
    }
    this._hoverKey = '';
  }

  private _scheduleHoverOpen(hitKey: string, hit: HitResult, ctx: DragDropContext): void {
    if (hitKey === this._hoverKey) return;
    this._clearHoverTimer();
    if (!hit.folder && hit.segmentIndex === null && hit.tabIndex === null && !hit.sidebarItem)
      return;

    this._hoverKey = hitKey;
    this._hoverTimer = setTimeout(() => {
      this._hoverTimer = null;
      if (!this.isDragging()) return;

      if (hit.folder?.entry.IsDir) {
        if (!this._items.some(item => item.entry.Path === hit.folder!.entry.Path)) {
          this._cb.navigateTo(hit.folder);
        }
        return;
      }

      if (hit.segmentIndex !== null) {
        if (hit.segmentIndex < 0) {
          this._cb.updatePath('');
        } else {
          this._cb.navigateToSegment(hit.segmentIndex);
        }
        return;
      }

      if (hit.tabIndex !== null) {
        this._cb.switchTab(hit.tabIndex);
        return;
      }

      if (hit.sidebarItem) {
        if (hit.sidebarItem === 'starred') {
          this._cb.selectStarred();
        } else if (hit.sidebarItem.startsWith('bookmark:')) {
          const bmPath = hit.sidebarItem.replace('bookmark:', '');
          const bm = ctx.bookmarks.find(b => b.entry.Path === bmPath);
          if (bm) this._cb.openBookmark(bm);
        } else if (hit.sidebarItem.startsWith('remote:')) {
          const remoteName = hit.sidebarItem.replace('remote:', '');
          const remote = ctx.allRemotesLookup.find(r => r.name === remoteName);
          if (remote) this._cb.selectRemote(remote);
        }
      }
    }, HOVER_OPEN_DELAY_MS);
  }

  // ---------------------------------------------------------------------------
  // Private: drop processing
  // ---------------------------------------------------------------------------

  private async _processDrop(
    event: DragEvent,
    target: { remote: ExplorerRoot | null; path: string },
    providedFsEntries?: FileSystemEntry[]
  ): Promise<void> {
    event.preventDefault();

    if (target.remote && this._hasExternalFiles(event)) {
      await this._processExternalDrop(event, target, providedFsEntries);
      return;
    }

    const data = event.dataTransfer?.getData(NAUTILUS_DRAG_MIME_TYPE);
    if (!data || !target.remote) return;

    const payload: NautilusDragPayload = JSON.parse(data);
    const { items } = payload;
    if (!items.length) return;

    if (items.some(item => item.entry.IsDir && item.entry.Path === target.path)) return;

    const sourceParentPath = items[0].entry.Path.substring(
      0,
      items[0].entry.Path.lastIndexOf(items[0].entry.Name)
    ).replace(/\/$/, '');
    const isSameRemote =
      this.pathSel.normalizeRemoteName(items[0].meta.remote ?? '') ===
      this.pathSel.normalizeRemoteName(target.remote.name);
    if (isSameRemote && sourceParentPath === target.path.replace(/\/$/, '')) return;

    await this.fileOps.performFileOperations(
      items,
      target.remote,
      target.path,
      isSameRemote ? 'move' : 'copy'
    );
    this._cb.refresh();
  }

  private async _processExternalDrop(
    event: DragEvent,
    target: { remote: ExplorerRoot | null; path: string },
    providedFsEntries?: FileSystemEntry[]
  ): Promise<void> {
    if (!target.remote) return;

    const dt = event.dataTransfer;
    if (!dt) return;

    const fsEntries = providedFsEntries ?? this._snapshotEntries(dt.items);
    if (!fsEntries.length) return;

    const allEntries: { entry: FileSystemEntry; relativePath: string; isDir: boolean }[] = [];
    for (const fsEntry of fsEntries) {
      allEntries.push(...(await this._collectFileEntries(fsEntry)));
    }

    if (!allEntries.length) return;

    const seen = new Set<string>();
    const filesToUpload: { file: File; relativePath: string }[] = [];
    const normalized = this._normalizeRemote(target.remote);

    for (const item of allEntries) {
      if (seen.has(item.relativePath)) continue;
      seen.add(item.relativePath);

      if (item.isDir) {
        // Just create empty directories as they are encountered
        await this.remoteOps
          .makeDirectory(normalized, `${target.path}/${item.relativePath}`, ORIGINS.FILEMANAGER)
          .catch(error => {
            console.error(error);
            this.notifications.showError(
              this.translate.instant('nautilus.notifications.mkdirFailed', {
                path: `${target.path}/${item.relativePath}`,
              })
            );
          });
      } else {
        const file = await this._readFileEntry(item.entry as FileSystemFileEntry);
        filesToUpload.push({ file, relativePath: item.relativePath });
      }
    }

    if (filesToUpload.length === 0) return;

    const { successCount, failedPaths } = await this.remoteOps.uploadWebFilesBatch(
      normalized,
      target.path,
      filesToUpload,
      ORIGINS.FILEMANAGER
    );

    if (successCount > 0) {
      this._cb.refresh();
    }

    if (failedPaths.length === 0 && successCount > 0) {
      this.notifications.showSuccess(
        this.translate.instant('nautilus.notifications.uploadSuccess', { count: successCount })
      );
    } else if (failedPaths.length > 0 && successCount > 0) {
      this.notifications.showWarning(
        this.translate.instant('nautilus.notifications.uploadFailed', { count: failedPaths.length })
      );
    } else if (failedPaths.length > 0) {
      this.notifications.showError(
        this.translate.instant('nautilus.notifications.uploadFailed', { count: failedPaths.length })
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Private: file-system utilities
  // ---------------------------------------------------------------------------

  private _hasExternalFiles(event: DragEvent): boolean {
    const dt = event.dataTransfer;
    if (!dt) return false;
    if (dt.files.length > 0) return true;
    return Array.from(dt.items).some(item => item.kind === 'file');
  }

  private _snapshotEntries(items: DataTransferItemList): FileSystemEntry[] {
    const entries: FileSystemEntry[] = [];
    for (const item of items) {
      const entry = item.webkitGetAsEntry?.();
      if (entry) entries.push(entry);
    }
    return entries;
  }

  private _readFileEntry(entry: FileSystemFileEntry): Promise<File> {
    return new Promise((res, rej) => entry.file(res, rej));
  }

  private _readDirEntries(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
    const reader = entry.createReader();
    const all: FileSystemEntry[] = [];
    return new Promise((res, rej) => {
      const readBatch = (): void => {
        reader.readEntries(batch => {
          if (!batch.length) {
            res(all);
            return;
          }
          all.push(...batch);
          readBatch();
        }, rej);
      };
      readBatch();
    });
  }

  private async _collectFileEntries(
    entry: FileSystemEntry,
    prefix = ''
  ): Promise<{ entry: FileSystemEntry; relativePath: string; isDir: boolean }[]> {
    const results: { entry: FileSystemEntry; relativePath: string; isDir: boolean }[] = [];
    const currentPath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isFile) {
      results.push({
        entry: entry as FileSystemFileEntry,
        relativePath: currentPath,
        isDir: false,
      });
    } else if (entry.isDirectory) {
      results.push({
        entry: entry as FileSystemDirectoryEntry,
        relativePath: currentPath,
        isDir: true,
      });

      const children = await this._readDirEntries(entry as FileSystemDirectoryEntry);
      for (const child of children) {
        results.push(...(await this._collectFileEntries(child, currentPath)));
      }
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // Util
  // ---------------------------------------------------------------------------

  private _normalizeRemote(remote: ExplorerRoot): string {
    return remote.isLocal ? remote.name : this.pathSel.normalizeRemoteForRclone(remote.name);
  }
}
