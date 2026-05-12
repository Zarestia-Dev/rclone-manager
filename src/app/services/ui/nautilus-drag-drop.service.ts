import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
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
  refresh: (remote?: string, path?: string) => void;
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

interface InternalPointerDragState {
  items: FileBrowserItem[];
  paneIndex: 0 | 1;
  startPoint: { x: number; y: number };
  lastPoint: { x: number; y: number };
}

const HOVER_OPEN_DELAY_MS = 1000;
const GHOST_CARD_W = 240;
const GHOST_CARD_H = 44;
const GHOST_STACK_OFFSET = 4;
const GHOST_BG_CARDS = 2;

const NULL_HIT: HitResult = {
  folder: null,
  segmentIndex: null,
  tabIndex: null,
  sidebarItem: null,
  paneIndex: null,
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
@Injectable()
export class NautilusDragDropService {
  private readonly remoteOps = inject(RemoteFileOperationsService);
  private readonly pathSel = inject(PathSelectionService);
  private readonly notifications = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly fileOps = inject(NautilusFileOperationsService);
  private readonly destroyRef = inject(DestroyRef);

  // ── Public state ────────────────────────────────────────────────────────────
  readonly isInternalDragging = signal(false);
  readonly isExternalDragging = signal(false);
  readonly isDragging = computed(() => this.isInternalDragging() || this.isExternalDragging());
  readonly hoveredFolder = signal<FileBrowserItem | null>(null);
  readonly hoveredFolderPaneIndex = signal<number | null>(null);
  readonly hoveredSegmentIndex = signal<number | null>(null);
  readonly hoveredTabIndex = signal<number | null>(null);
  readonly hoveredSidebarItem = signal<string | null>(null);

  // ── Private state ────────────────────────────────────────────────────────────
  private _items: FileBrowserItem[] = [];
  private _counter = 0;
  private _lastHitKey = '';
  private _hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private _hoverKey = '';
  private _internalPointerDrag: InternalPointerDragState | null = null;
  private _dragGhostEl: HTMLElement | null = null;
  private _dragGhostHost: HTMLElement | null = null;
  private _cb!: DragDropCallbacks;

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  register(cb: DragDropCallbacks): void {
    this._cb = cb;
  }

  async setupDesktopNativeDropListener(): Promise<void> {
    if (isHeadlessMode()) return;

    try {
      const unlisten = await getCurrentWindow().onDragDropEvent(async event => {
        if (this.isInternalDragging()) return;

        if (event.payload.type === 'enter' || event.payload.type === 'over') {
          this.isExternalDragging.set(true);
          return;
        }

        if (event.payload.type === 'leave') {
          this.isExternalDragging.set(false);
          return;
        }

        if (event.payload.type !== 'drop' || event.payload.paths.length === 0) return;

        this.isExternalDragging.set(false);
        this.endDrag();

        const target = this._resolveDropTargetFromPoint(
          event.payload.position.x,
          event.payload.position.y
        );
        if (!target.remote) return;

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
    if (event.dataTransfer) {
      const payload: NautilusDragPayload = { items, sourcePaneIndex: paneIndex };
      event.dataTransfer.effectAllowed = 'copyMove';
      event.dataTransfer.setData(NAUTILUS_DRAG_MIME_TYPE, JSON.stringify(payload));
    }
  }

  beginInternalPointerDrag(
    items: FileBrowserItem[],
    paneIndex: 0 | 1,
    point: { x: number; y: number },
    svgIcon: SVGElement | null = null
  ): void {
    this.isInternalDragging.set(true);
    this.isExternalDragging.set(false);
    this._lastHitKey = '';
    this._items = items;
    this._internalPointerDrag = {
      items,
      paneIndex,
      startPoint: point,
      lastPoint: point,
    };

    this._dragGhostEl?.remove();
    this._dragGhostHost = document.documentElement;
    this._dragGhostEl = this._createDragGhost(items, svgIcon);
    this._dragGhostHost.appendChild(this._dragGhostEl);
    if ('popover' in this._dragGhostEl) {
      try {
        (this._dragGhostEl as any).popover = 'manual';
        (this._dragGhostEl as any).showPopover();
      } catch {
        // Popover API might not be supported
      }
    }
    this._updateDragGhostPosition(point.x + 12, point.y + 12);
  }

  updateInternalPointerDrag(point: { x: number; y: number }): void {
    if (!this._internalPointerDrag) return;
    this._internalPointerDrag.lastPoint = point;
    this._updateDragGhostPosition(point.x + 12, point.y + 12);
    this._onMove(point);
  }

  private _createDragGhost(items: FileBrowserItem[], svgIcon: SVGElement | null): HTMLElement {
    const isMulti = items.length > 1;
    const bgCards = isMulti ? GHOST_BG_CARDS : 0;
    const wrapper = document.createElement('div');

    Object.assign(wrapper.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      margin: '0',
      padding: '0',
      border: 'none',
      background: 'transparent',
      zIndex: '2147483647',
      pointerEvents: 'none',
      width: `${GHOST_CARD_W + bgCards * GHOST_STACK_OFFSET}px`,
      height: `${GHOST_CARD_H + bgCards * GHOST_STACK_OFFSET}px`,
      opacity: '1',
      visibility: 'visible',
    });

    for (let step = bgCards; step >= 1; step--) {
      const bg = document.createElement('div');
      const opacity = 0.45 + ((bgCards - step) / bgCards) * 0.25;
      Object.assign(bg.style, {
        position: 'absolute',
        top: `${(bgCards - step) * GHOST_STACK_OFFSET}px`,
        left: `${step * GHOST_STACK_OFFSET}px`,
        width: `${GHOST_CARD_W}px`,
        height: `${GHOST_CARD_H}px`,
        borderRadius: 'var(--card-border-radius, 10px)',
        background: 'var(--sidebar-bg-color, #272a2f)',
        border: '1px solid var(--card-shade-color, rgba(255, 255, 255, 0.12))',
        boxSizing: 'border-box',
        opacity: String(opacity),
      });
      wrapper.appendChild(bg);
    }

    const front = document.createElement('div');
    Object.assign(front.style, {
      position: 'absolute',
      top: `${bgCards * GHOST_STACK_OFFSET}px`,
      left: '0',
      width: `${GHOST_CARD_W}px`,
      height: `${GHOST_CARD_H}px`,
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-xs)',
      padding: '0 var(--space-sm)',
      borderRadius: 'var(--card-border-radius, 10px)',
      background: 'var(--popover-bg-color, #2f3136)',
      border: '1px solid var(--card-shade-color, rgba(255, 255, 255, 0.12))',
      boxShadow: 'var(--shadow-popover, 0 8px 24px rgba(0, 0, 0, 0.35))',
      boxSizing: 'border-box',
      overflow: 'hidden',
    });

    const iconWrapper = document.createElement('span');
    Object.assign(iconWrapper.style, {
      width: 'var(--icon-size-sm)',
      height: 'var(--icon-size-sm)',
      flexShrink: '0',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    });

    if (svgIcon) {
      const clone = svgIcon.cloneNode(true) as SVGElement;
      Object.assign(clone.style, {
        width: 'var(--icon-size-sm)',
        height: 'var(--icon-size-sm)',
        display: 'block',
        color: items[0]?.entry.IsDir ? 'var(--accent-color)' : 'var(--dim-color)',
      });
      iconWrapper.appendChild(clone);
    } else {
      iconWrapper.textContent = items[0]?.entry.IsDir ? '📁' : '📄';
    }
    front.appendChild(iconWrapper);

    const label = document.createElement('span');
    Object.assign(label.style, {
      flex: '1',
      minWidth: '0',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontSize: 'var(--font-size-md)',
      fontWeight: '500',
      color: 'var(--window-fg-color, #f3f4f6)',
    });
    label.textContent = items[0]?.entry.Name ?? '';
    front.appendChild(label);

    if (isMulti) {
      const badge = document.createElement('span');
      Object.assign(badge.style, {
        flexShrink: '0',
        borderRadius: 'var(--radius-xs, 6px)',
        padding: 'var(--space-xxs, 2px) var(--space-xs, 6px)',
        fontSize: 'var(--font-size-sm)',
        fontWeight: '700',
        color: 'var(--accent-fg-color, #ffffff)',
        background: 'var(--accent-color, #0ea5e9)',
      });
      badge.textContent = items.length.toString();
      front.appendChild(badge);
    }

    wrapper.appendChild(front);
    return wrapper;
  }

  private _updateDragGhostPosition(x: number, y: number): void {
    if (!this._dragGhostEl) return;
    this._dragGhostEl.style.left = `${x}px`;
    this._dragGhostEl.style.top = `${y}px`;
  }

  async commitInternalPointerDrag(point: { x: number; y: number }): Promise<void> {
    if (!this._internalPointerDrag) return;

    const ctx = this._cb.getContext();
    const target = this._resolveDropTargetFromPoint(point.x, point.y);

    if (!target.remote) {
      this.cancelInternalPointerDrag();
      return;
    }

    try {
      await this._processInternalItemsDrop(this._internalPointerDrag.items, target);
    } finally {
      this.cancelInternalPointerDrag();
      if (ctx.activeRemote) {
        this._cb.refresh(ctx.activeRemote.name, ctx.activePath);
      }
    }
  }

  cancelInternalPointerDrag(): void {
    if (!this._internalPointerDrag) return;
    this._internalPointerDrag = null;
    this.endDrag();
  }

  endDrag(): void {
    this.isInternalDragging.set(false);
    this.isExternalDragging.set(false);
    this._counter = 0;
    this._lastHitKey = '';
    this._items = [];
    this._internalPointerDrag = null;
    this._dragGhostEl?.remove();
    this._dragGhostEl = null;
    this._dragGhostHost = null;
    this._clearHoverTimer();
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
    if (this._counter === 1 && this._items.length > 0) {
      this.isInternalDragging.set(true);
    } else if (this._counter === 1) {
      this.isExternalDragging.set(true);
    }
  }

  onContainerDragLeave(_event: DragEvent): void {
    this._counter--;
    if (this._counter <= 0) {
      this._counter = 0;
      if (this._items.length === 0) {
        this.isExternalDragging.set(false);
      } else {
        this.isInternalDragging.set(false);
      }
    }
  }

  onContainerDrop(event: DragEvent): void {
    event.preventDefault();
    const ctx = this._cb.getContext();

    if (
      isHeadlessMode() &&
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
  // Private: hover-open timer
  // ---------------------------------------------------------------------------

  private _onMove(point: { x: number; y: number }): void {
    const ctx = this._cb.getContext();
    const hit = this._resolveDropHit(point, ctx);

    const hitKey = `${hit.paneIndex}:${hit.tabIndex}:${hit.segmentIndex}:${hit.folder?.entry.Path}:${hit.sidebarItem}`;
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

  private _scheduleHoverOpen(hitKey: string, hit: HitResult, ctx: DragDropContext): void {
    if (hitKey === this._hoverKey) return;
    this._clearHoverTimer();
    if (!hit.folder && hit.segmentIndex === null && hit.tabIndex === null && !hit.sidebarItem)
      return;

    this._hoverKey = hitKey;
    this._hoverTimer = setTimeout(() => {
      this._hoverTimer = null;
      if (!this.isDragging()) return;

      const hitFolder = hit.folder;
      if (hitFolder?.entry.IsDir) {
        if (!this._items.some(item => item.entry.Path === hitFolder.entry.Path)) {
          this._cb.navigateTo(hitFolder);
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

  private _clearHoverTimer(): void {
    if (this._hoverTimer !== null) {
      clearTimeout(this._hoverTimer);
      this._hoverTimer = null;
    }
    this._hoverKey = '';
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

    if (target.remote && this._hasExternalFiles(event) && isHeadlessMode()) {
      await this._processExternalDrop(event, target, providedFsEntries);
      return;
    }

    const data = event.dataTransfer?.getData(NAUTILUS_DRAG_MIME_TYPE);
    if (!data || !target.remote) return;

    const payload: NautilusDragPayload = JSON.parse(data);
    await this._processInternalItemsDrop(payload.items, target);
  }

  private async _processInternalItemsDrop(
    items: FileBrowserItem[],
    target: { remote: ExplorerRoot | null; path: string }
  ): Promise<void> {
    if (!target.remote || !items.length) return;

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
    this._cb.refresh(target.remote.name, target.path);
    if (isSameRemote) {
      this._cb.refresh(target.remote.name, sourceParentPath);
    }
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

    const normalized = this._normalizeRemote(target.remote);
    const seen = new Set<string>();
    const filesToUpload: { file: File; relativePath: string }[] = [];

    for (const item of allEntries) {
      if (seen.has(item.relativePath)) continue;
      seen.add(item.relativePath);

      if (item.isDir) {
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

    this._cb.refresh(target.remote.name, target.path);

    if (failedPaths.length === 0 && successCount > 0) {
      this.notifications.showSuccess(
        this.translate.instant('nautilus.notifications.uploadSuccess', { count: successCount })
      );
    } else if (failedPaths.length > 0 && successCount > 0) {
      this.notifications.showWarning(
        this.translate.instant('nautilus.notifications.uploadFailed', {
          count: failedPaths.length,
        })
      );
    } else if (failedPaths.length > 0) {
      this.notifications.showError(
        this.translate.instant('nautilus.notifications.uploadFailed', {
          count: failedPaths.length,
        })
      );
    }
  }

  private _resolveDropHit(point: { x: number; y: number }, ctx: DragDropContext): HitResult {
    const el = document.elementFromPoint(point.x, point.y);
    if (!el) return NULL_HIT;

    const getAttr = (selector: string, attr: string): string | null | undefined =>
      el.closest(selector)?.getAttribute(attr);
    const hasTag = (selector: string): boolean => !!el.closest(selector);

    const paneIdxRaw = getAttr('[data-pane-index]', 'data-pane-index');
    const paneIndex = paneIdxRaw != null ? parseInt(paneIdxRaw, 10) : null;
    const targetPaneIndex = paneIndex ?? ctx.activePaneIndex;

    const folderPath = getAttr('[data-folder-path]', 'data-folder-path');
    const currentFiles = targetPaneIndex === 0 ? ctx.files : ctx.filesRight;
    const folder = folderPath
      ? (currentFiles.find(f => f.entry.Path === folderPath) ?? null)
      : null;

    const segIdxRaw = getAttr('[data-segment-index]', 'data-segment-index');
    const segmentIndex = segIdxRaw ? parseInt(segIdxRaw, 10) : null;

    const tabIdxRaw = getAttr('[data-tab-index]', 'data-tab-index');
    const tabIndex = tabIdxRaw ? parseInt(tabIdxRaw, 10) : null;

    let sidebarItem: string | null = null;
    if (hasTag('[data-sidebar-starred]')) {
      sidebarItem = 'starred';
    } else if (hasTag('[data-sidebar-bookmarks-header]')) {
      sidebarItem = 'bookmarks-header';
    } else {
      const bmPath = getAttr('[data-sidebar-bookmark-path]', 'data-sidebar-bookmark-path');
      if (bmPath) {
        sidebarItem = `bookmark:${bmPath}`;
      } else {
        const remoteName = getAttr('[data-sidebar-remote-name]', 'data-sidebar-remote-name');
        if (remoteName) sidebarItem = `remote:${remoteName}`;
      }
    }

    return { folder, segmentIndex, tabIndex, sidebarItem, paneIndex };
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
      if (tab?.left.remote) {
        return { remote: tab.left.remote, path: tab.left.path };
      }
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

  // ---------------------------------------------------------------------------
  // Private: FileSystem API utilities
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
  // Private: utilities
  // ---------------------------------------------------------------------------

  private _normalizeRemote(remote: ExplorerRoot): string {
    return remote.isLocal ? remote.name : this.pathSel.normalizeRemoteForRclone(remote.name);
  }
}
