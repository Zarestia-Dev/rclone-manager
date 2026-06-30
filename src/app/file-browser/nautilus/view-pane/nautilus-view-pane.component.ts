import {
  Component,
  input,
  output,
  inject,
  TemplateRef,
  computed,
  signal,
  viewChild,
  ElementRef,
  OnDestroy,
  ChangeDetectionStrategy,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatButtonModule } from '@angular/material/button';
import { CdkMenuModule } from '@angular/cdk/menu';
import { MatTableModule } from '@angular/material/table';
import { TranslatePipe } from '@ngx-translate/core';
import { FormatFileSizePipe, FormatRelativeDatePipe } from '@app/pipes';
import { IconService } from 'src/app/services/ui/icon.service';
import { NautilusService } from 'src/app/services/ui/nautilus.service';
import { NautilusDragDropService } from 'src/app/services/ui/nautilus-drag-drop.service';
import { Entry, FileBrowserItem } from '@app/types';

@Component({
  selector: 'app-nautilus-view-pane',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [
    NgTemplateOutlet,
    MatIconModule,
    MatProgressSpinnerModule,
    MatButtonModule,
    CdkMenuModule,
    MatTableModule,
    TranslatePipe,
    FormatFileSizePipe,
    FormatRelativeDatePipe,
  ],
  templateUrl: './nautilus-view-pane.component.html',
  styleUrl: './nautilus-view-pane.component.scss',
})
export class NautilusViewPaneComponent implements OnDestroy {
  readonly gridContainer = viewChild<ElementRef<HTMLElement>>('gridContainer');
  readonly listContainer = viewChild<ElementRef<HTMLElement>>('listContainer');

  private readonly nautilusService = inject(NautilusService);
  protected readonly dragDrop = inject(NautilusDragDropService);
  protected readonly iconService = inject(IconService);

  // --- Inputs ---
  public readonly files = input.required<FileBrowserItem[]>();
  public readonly selection = input.required<Set<string>>();
  public readonly paneIndex = input.required<0 | 1>();
  public readonly isSplitEnabled = input.required<boolean>();
  public readonly loading = input.required<boolean>();
  public readonly error = input<string | null>(null);

  public readonly layout = input.required<'grid' | 'list'>();
  public readonly iconSize = input.required<number>();
  public readonly listRowHeight = input.required<number>();
  public readonly isDragging = input.required<boolean>();
  public readonly hoveredFolder = input<FileBrowserItem | null>(null);
  public readonly hoveredFolderPaneIndex = input<number | null>(null);
  public readonly cutItemPaths = input.required<Set<string>>();
  public readonly starredMode = input.required<boolean>();
  public readonly sortKey = input.required<string>();
  public readonly sortDirection = input.required<'asc' | 'desc'>();
  public readonly activePaneIndex = input.required<0 | 1>();
  public readonly isItemSelectable = input.required<(entry: Entry) => boolean>();
  public readonly isMobile = input<boolean>(false);
  public readonly fileMenu = input<TemplateRef<unknown> | null | undefined>(undefined);
  public readonly isMultiSelectEnabled = input<boolean>(true);

  // --- Outputs ---
  public readonly switchPane = output<0 | 1>();
  public readonly clearSelection = output<0 | 1>();
  public readonly setContextItem = output<FileBrowserItem | null>();
  public readonly dropToCurrentDirectory = output<{ event: DragEvent; paneIndex: 0 | 1 }>();
  public readonly dragStarted = output<{ event: DragEvent; item: FileBrowserItem }>();
  public readonly dragEnded = output<void>();
  public readonly itemClick = output<{ item: FileBrowserItem; event: Event; index: number }>();
  public readonly navigateTo = output<FileBrowserItem>();
  public readonly toggleStar = output<FileBrowserItem>();
  public readonly toggleSort = output<string>();
  public readonly refresh = output<void>();
  public readonly cancelLoad = output<0 | 1>();
  public readonly updateSelection = output<Set<string>>();

  // --- State ---
  protected readonly lassoActive = signal(false);
  protected readonly lassoRect = signal({ left: 0, top: 0, width: 0, height: 0 });
  private _lassoStart = { x: 0, y: 0 };
  private _isLassoing = false;
  private _lassoJustFinished = false;
  private _lastMoveEvent?: MouseEvent;
  private _autoScrollRafId: number | null = null;
  private _lassoRafId: number | null = null;

  // --- Computeds ---
  protected readonly gridColumns = computed(() => `repeat(auto-fill, ${this.iconSize() + 40}px)`);
  protected readonly displayedColumns = computed((): string[] =>
    this.starredMode() ? ['name', 'size', 'modified', 'star'] : ['name', 'size', 'modified']
  );

  // ---------------------------------------------------------------------------
  // Drag — ghost + self-hover fix
  // ---------------------------------------------------------------------------

  protected readonly _draggedItemPath = signal<string | null>(null);

  private _pendingPointerDrag: {
    item: FileBrowserItem;
    items: FileBrowserItem[];
    pointerId: number;
    startX: number;
    startY: number;
    started: boolean;
    svgIcon: SVGElement | null;
  } | null = null;
  private _ignoreNextItemClick = false;

  private readonly _onWindowPointerMove = (event: PointerEvent): void => {
    if (!this._pendingPointerDrag || event.pointerId !== this._pendingPointerDrag.pointerId) return;

    const dx = Math.abs(event.clientX - this._pendingPointerDrag.startX);
    const dy = Math.abs(event.clientY - this._pendingPointerDrag.startY);

    if (!this._pendingPointerDrag.started) {
      if (dx < 4 && dy < 4) return;

      this._pendingPointerDrag.started = true;
      this._draggedItemPath.set(this._pendingPointerDrag.item.entry.Path);
      this.dragDrop.beginInternalPointerDrag(
        this._pendingPointerDrag.items,
        this.paneIndex(),
        { x: event.clientX, y: event.clientY },
        this._pendingPointerDrag.svgIcon
      );
      event.preventDefault();
      return;
    }

    this.dragDrop.updateInternalPointerDrag({ x: event.clientX, y: event.clientY });
    event.preventDefault();
  };

  private readonly _onWindowPointerUp = async (event: PointerEvent): Promise<void> => {
    if (!this._pendingPointerDrag || event.pointerId !== this._pendingPointerDrag.pointerId) return;

    const wasDragging = this._pendingPointerDrag.started;
    this._pendingPointerDrag = null;
    this._removePointerListeners();

    if (wasDragging) {
      this._ignoreNextItemClick = true;
      setTimeout(() => {
        this._ignoreNextItemClick = false;
      }, 0);
      await this.dragDrop.commitInternalPointerDrag({ x: event.clientX, y: event.clientY });
    } else {
      this._draggedItemPath.set(null);
    }
  };

  private readonly _onWindowPointerCancel = (): void => {
    if (!this._pendingPointerDrag) return;
    this._pendingPointerDrag = null;
    this._draggedItemPath.set(null);
    this.dragDrop.cancelInternalPointerDrag();
    this._removePointerListeners();
  };

  private _removePointerListeners(): void {
    window.removeEventListener('pointermove', this._onWindowPointerMove);
    window.removeEventListener('pointerup', this._onWindowPointerUp);
    window.removeEventListener('pointercancel', this._onWindowPointerCancel);
  }

  private get _activeContainer(): HTMLElement | undefined {
    const ref = this.layout() === 'grid' ? this.gridContainer() : this.listContainer();
    return ref?.nativeElement;
  }

  // ---------------------------------------------------------------------------
  // Pointer / item interaction
  // ---------------------------------------------------------------------------

  protected onItemPointerDown(event: PointerEvent, item: FileBrowserItem): void {
    if (event.button !== 0 || !this.isMultiSelectEnabled()) return;

    const target = event.target as HTMLElement;
    if (target.closest('button') || target.closest('a')) return;

    event.preventDefault();
    event.stopPropagation();

    const itemKey = this.getItemKey(item);
    const items = this.selection().has(itemKey)
      ? this.files().filter(f => this.selection().has(this.getItemKey(f)))
      : [item];

    const itemEl = event.currentTarget as HTMLElement;
    const svgIcon = itemEl.querySelector<SVGElement>('mat-icon:not(.cut-icon) svg') ?? null;

    this._pendingPointerDrag = {
      item,
      items,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
      svgIcon,
    };

    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    window.addEventListener('pointermove', this._onWindowPointerMove);
    window.addEventListener('pointerup', this._onWindowPointerUp);
    window.addEventListener('pointercancel', this._onWindowPointerCancel);
  }

  protected onItemClick(event: MouseEvent, item: FileBrowserItem, index: number): void {
    if (this._ignoreNextItemClick) {
      event.stopPropagation();
      event.preventDefault();
      return;
    }

    this.itemClick.emit({ item, event, index });
    event.stopPropagation();
  }

  protected onItemPointerUp(event: PointerEvent): void {
    if (!this._pendingPointerDrag || event.pointerId !== this._pendingPointerDrag.pointerId) return;

    if (!this._pendingPointerDrag.started) {
      this._pendingPointerDrag = null;
      this._removePointerListeners();
    }
  }

  protected onItemKeydown(event: Event, item: FileBrowserItem, index: number): void {
    this.itemClick.emit({ item, event, index });
    this.navigateTo.emit(item);
    event.preventDefault();
    event.stopPropagation();
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  protected isStarred(item: FileBrowserItem): boolean {
    return this.nautilusService.isSaved('starred', item.meta.remote || '', item.entry.Path);
  }

  protected isDraggingItem(item: FileBrowserItem): boolean {
    return this._draggedItemPath() === item.entry.Path;
  }

  protected getItemKey(item: FileBrowserItem): string {
    return `${item.meta.remote}:${item.entry.Path}`;
  }

  // ---------------------------------------------------------------------------
  // Lasso Selection
  // ---------------------------------------------------------------------------

  protected onMouseDown(event: MouseEvent): void {
    // Emit pane switch on any left-click before any early returns.
    if (event.button === 0) {
      this.switchPane.emit(this.paneIndex());
    }
    if (event.button !== 0 || !this.isMultiSelectEnabled()) return;

    const target = event.target as HTMLElement;
    // CHANGED: use _activeContainer getter instead of inline ternary.
    const container = this._activeContainer;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const isScrollbar =
      event.clientX > rect.left + container.clientWidth ||
      event.clientY > rect.top + container.clientHeight;
    if (isScrollbar) return;

    if (
      target.closest('.grid-item') ||
      target.closest('tr.mat-mdc-row') ||
      target.closest('button') ||
      target.closest('a')
    ) {
      return;
    }

    event.preventDefault();

    this._lassoStart = {
      x: event.clientX - rect.left + container.scrollLeft,
      y: event.clientY - rect.top + container.scrollTop,
    };

    this._isLassoing = false;
    this._lassoJustFinished = false;

    this.lassoActive.set(true);
    this.lassoRect.set({ left: this._lassoStart.x, top: this._lassoStart.y, width: 0, height: 0 });

    const moveHandler = (e: MouseEvent): void => {
      this._lastMoveEvent = e;
      this._scheduleLassoFrame();
    };
    const scrollHandler = (): void => {
      if (this._lastMoveEvent) this._scheduleLassoFrame();
      else this._updateLassoSelection();
    };
    const upHandler = (): void => {
      this._onMouseUp();
      window.removeEventListener('mousemove', moveHandler);
      window.removeEventListener('mouseup', upHandler);
      container.removeEventListener('scroll', scrollHandler);
    };

    window.addEventListener('mousemove', moveHandler);
    window.addEventListener('mouseup', upHandler);
    container.addEventListener('scroll', scrollHandler);
  }

  private _scheduleLassoFrame(): void {
    if (this._lassoRafId !== null) return;
    this._lassoRafId = requestAnimationFrame(() => {
      this._lassoRafId = null;
      if (this._lastMoveEvent) this._onMouseMove(this._lastMoveEvent);
    });
  }

  private _onMouseMove(event: MouseEvent): void {
    if (!this.lassoActive()) return;

    const container = this._activeContainer;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    let currentX = event.clientX - rect.left + container.scrollLeft;
    let currentY = event.clientY - rect.top + container.scrollTop;

    currentX = Math.max(0, Math.min(currentX, container.clientWidth));
    currentY = Math.max(0, Math.min(currentY, container.scrollHeight));

    const width = Math.abs(this._lassoStart.x - currentX);
    const height = Math.abs(this._lassoStart.y - currentY);
    const left = Math.min(this._lassoStart.x, currentX);
    const top = Math.min(this._lassoStart.y, currentY);

    if (width > 5 || height > 5) {
      this._isLassoing = true;
    }

    this.lassoRect.set({ left, top, width, height });
    this._handleAutoScroll(event, container);
    this._updateLassoSelection();
  }

  private _onMouseUp(): void {
    if (this._isLassoing) {
      this._lassoJustFinished = true;
      setTimeout(() => (this._lassoJustFinished = false), 150);
    }
    this.lassoActive.set(false);
    this._lastMoveEvent = undefined;
    this._stopAutoScroll();

    if (this._lassoRafId !== null) {
      cancelAnimationFrame(this._lassoRafId);
      this._lassoRafId = null;
    }
  }

  protected onContainerClick(event: MouseEvent): void {
    if (this._lassoJustFinished) {
      event.stopPropagation();
      return;
    }
    this.clearSelection.emit(this.paneIndex());
  }

  private _handleAutoScroll(event: MouseEvent, container: HTMLElement): void {
    const rect = container.getBoundingClientRect();
    const threshold = 40;
    let scrollY = 0;

    if (event.clientY < rect.top + threshold) scrollY = -15;
    else if (event.clientY > rect.bottom - threshold) scrollY = 15;

    this._stopAutoScroll();
    if (scrollY !== 0) {
      const tick = (): void => {
        container.scrollBy(0, scrollY);
        this._updateLassoSelection();
        this._autoScrollRafId = requestAnimationFrame(tick);
      };
      this._autoScrollRafId = requestAnimationFrame(tick);
    }
  }

  private _stopAutoScroll(): void {
    if (this._autoScrollRafId !== null) {
      cancelAnimationFrame(this._autoScrollRafId);
      this._autoScrollRafId = null;
    }
  }

  private _updateLassoSelection(): void {
    const container = this._activeContainer;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const lasso = this.lassoRect();

    const lassoViewport = {
      left: lasso.left - container.scrollLeft + containerRect.left,
      top: lasso.top - container.scrollTop + containerRect.top,
      right: lasso.left - container.scrollLeft + containerRect.left + lasso.width,
      bottom: lasso.top - container.scrollTop + containerRect.top + lasso.height,
    };

    const newSelection = new Set<string>();
    const selector = this.layout() === 'grid' ? '.grid-item' : 'tr.mat-mdc-row';
    const items = container.querySelectorAll(selector);

    items.forEach((itemEl: Element) => {
      const itemKey = (itemEl as HTMLElement).getAttribute('data-item-key');
      if (!itemKey) return;

      const itemRect = itemEl.getBoundingClientRect();
      const intersects =
        lassoViewport.left <= itemRect.right &&
        lassoViewport.right >= itemRect.left &&
        lassoViewport.top <= itemRect.bottom &&
        lassoViewport.bottom >= itemRect.top;

      if (intersects) newSelection.add(itemKey);
    });

    const current = this.selection();
    const isDifferent =
      newSelection.size !== current.size || [...newSelection].some(k => !current.has(k));

    if (isDifferent) {
      this.updateSelection.emit(newSelection);
    }
  }

  ngOnDestroy(): void {
    this._stopAutoScroll();
    if (this._lassoRafId !== null) {
      cancelAnimationFrame(this._lassoRafId);
    }
    this._removePointerListeners();
  }
}
