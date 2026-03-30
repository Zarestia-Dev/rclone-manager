import {
  Component,
  input,
  output,
  inject,
  TemplateRef,
  computed,
  signal,
  ViewChild,
  ElementRef,
  OnDestroy,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatButtonModule } from '@angular/material/button';
import { CdkMenuModule } from '@angular/cdk/menu';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { MatTableModule } from '@angular/material/table';
import { TranslateModule } from '@ngx-translate/core';
import { FormatFileSizePipe } from '@app/pipes';
import { IconService, NautilusService } from '@app/services';
import { Entry, FileBrowserItem } from '@app/types';

// ---------------------------------------------------------------------------
// Drag ghost constants
// ---------------------------------------------------------------------------
const GHOST_CARD_W = 220;
const GHOST_CARD_H = 44;
const GHOST_STACK_OFFSET = 3;
const GHOST_BG_CARDS = 2;

@Component({
  selector: 'app-nautilus-view-pane',
  standalone: true,
  imports: [
    NgTemplateOutlet,
    MatIconModule,
    MatProgressSpinnerModule,
    MatButtonModule,
    CdkMenuModule,
    ScrollingModule,
    MatTableModule,
    TranslateModule,
    FormatFileSizePipe,
  ],
  templateUrl: './nautilus-view-pane.component.html',
  styleUrl: './nautilus-view-pane.component.scss',
})
export class NautilusViewPaneComponent implements OnDestroy {
  @ViewChild('paneWrapper') paneWrapper?: ElementRef<HTMLElement>;
  @ViewChild('gridContainer', { read: ElementRef }) gridContainer?: ElementRef<HTMLElement>;
  @ViewChild('listContainer', { read: ElementRef }) listContainer?: ElementRef<HTMLElement>;

  private readonly nautilusService = inject(NautilusService);
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
  public readonly cutItemPaths = input.required<Set<string>>();
  public readonly starredMode = input.required<boolean>();
  public readonly sortKey = input.required<string>();
  public readonly sortDirection = input.required<'asc' | 'desc'>();
  public readonly activePaneIndex = input.required<0 | 1>();
  public readonly isItemSelectable = input.required<(entry: Entry) => boolean>();
  public readonly fileMenu = input.required<TemplateRef<unknown>>();

  // --- Outputs ---
  public readonly switchPane = output<0 | 1>();
  public readonly clearSelection = output<void>();
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
  private _autoScrollTimer?: any;
  private _isLassoing = false;
  private _lassoJustFinished = false;
  private _lastMoveEvent?: MouseEvent;

  // --- Computeds ---
  protected readonly gridColumns = computed(() => `repeat(auto-fill, ${this.iconSize() + 40}px)`);
  protected readonly displayedColumns = computed((): string[] =>
    this.starredMode() ? ['name', 'size', 'modified', 'star'] : ['name', 'size', 'modified']
  );

  // ---------------------------------------------------------------------------
  // Drag — ghost + self-hover fix
  // ---------------------------------------------------------------------------

  protected readonly _draggedItemPath = signal<string | null>(null);

  private readonly _dateFormatter = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  protected onDragStart(event: DragEvent, item: FileBrowserItem): void {
    this._draggedItemPath.set(item.entry.Path);

    const itemEl = event.currentTarget as HTMLElement;
    const svgIcon = itemEl.querySelector<SVGElement>('mat-icon:not(.cut-icon) svg') ?? null;

    const ghost = this._buildDragGhost(item, svgIcon);
    document.body.appendChild(ghost);

    event.dataTransfer?.setDragImage(ghost, 0, 0);

    requestAnimationFrame(() => ghost.remove());
    this.dragStarted.emit({ event, item });
  }

  protected onDragEnd(): void {
    this._draggedItemPath.set(null);
    this.dragEnded.emit();
  }

  private _isMultiDrag(item: FileBrowserItem): boolean {
    return this.selection().has(this.getItemKey(item)) && this.selection().size > 1;
  }

  private _buildDragGhost(item: FileBrowserItem, svgIcon: SVGElement | null): HTMLElement {
    const isMulti = this._isMultiDrag(item);
    const bgCards = isMulti ? GHOST_BG_CARDS : 0;
    const wrapperW = GHOST_CARD_W + bgCards * GHOST_STACK_OFFSET;
    const wrapperH = GHOST_CARD_H + bgCards * GHOST_STACK_OFFSET;

    const wrapper = document.createElement('div');
    Object.assign(wrapper.style, {
      position: 'fixed',
      top: '-9999px',
      left: '-9999px',
      width: `${wrapperW}px`,
      height: `${wrapperH}px`,
      pointerEvents: 'none',
      fontFamily: 'system-ui, Inter, sans-serif',
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
        borderRadius: 'var(--card-border-radius)',
        background: 'var(--sidebar-bg-color)',
        border: '1px solid var(--card-shade-color)',
        opacity: String(opacity),
        boxSizing: 'border-box',
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
      borderRadius: 'var(--card-border-radius)',
      background: 'var(--popover-bg-color)',
      border: '1px solid var(--card-shade-color)',
      boxShadow: 'var(--shadow-popover)',
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-xs)',
      padding: '0 var(--space-sm)',
      overflow: 'hidden',
      boxSizing: 'border-box',
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
        color: item.entry.IsDir ? 'var(--accent-color)' : 'var(--dim-color)',
      });
      iconWrapper.appendChild(clone);
    } else {
      iconWrapper.textContent = item.entry.IsDir ? '📁' : '📄';
    }

    const label = document.createElement('span');
    Object.assign(label.style, {
      flex: '1',
      minWidth: '0',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontSize: 'var(--font-size-md)',
      fontWeight: '500',
      color: 'var(--window-fg-color)',
    });
    label.textContent = item.entry.Name;

    front.appendChild(iconWrapper);
    front.appendChild(label);

    if (isMulti) {
      const badge = document.createElement('span');
      Object.assign(badge.style, {
        flexShrink: '0',
        background: 'var(--accent-color)',
        color: 'var(--accent-fg-color)',
        borderRadius: 'var(--radius-xs)',
        padding: 'var(--space-xxs) var(--space-xs)',
        fontSize: 'var(--font-size-sm)',
        fontWeight: '700',
        lineHeight: '1.5',
        letterSpacing: '0.3px',
      });
      badge.textContent = String(this.selection().size);
      front.appendChild(badge);
    }

    wrapper.appendChild(front);
    return wrapper;
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  protected isStarred(item: FileBrowserItem): boolean {
    return this.nautilusService.isSaved('starred', item.meta.remote || '', item.entry.Path);
  }

  protected getItemKey(item: FileBrowserItem): string {
    return `${item.meta.remote}:${item.entry.Path}`;
  }

  protected formatRelativeDate(dateString: string): string {
    if (!dateString) return '';
    return this._dateFormatter.format(new Date(dateString));
  }

  // ---------------------------------------------------------------------------
  // Lasso Selection
  // ---------------------------------------------------------------------------

  protected onMouseDown(event: MouseEvent): void {
    // Only left click, and not on an item
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (
      target.closest('.grid-item') ||
      target.closest('tr.mat-mdc-row') ||
      target.closest('button') ||
      target.closest('a')
    ) {
      return;
    }

    const container =
      this.layout() === 'grid'
        ? this.gridContainer?.nativeElement
        : this.listContainer?.nativeElement;
    if (!container) return;

    event.preventDefault();

    const rect = container.getBoundingClientRect();
    this._lassoStart = {
      x: event.clientX - rect.left + container.scrollLeft,
      y: event.clientY - rect.top + container.scrollTop,
    };

    this._isLassoing = false;
    this._lassoJustFinished = false;

    this.lassoActive.set(true);
    this.lassoRect.set({ left: this._lassoStart.x, top: this._lassoStart.y, width: 0, height: 0 });

    const moveHandler = (e: MouseEvent) => {
      this._lastMoveEvent = e;
      this._onMouseMove(e);
    };
    const scrollHandler = () => {
      if (this._lastMoveEvent) this._onMouseMove(this._lastMoveEvent);
      else this._updateLassoSelection();
    };
    const upHandler = () => {
      this._onMouseUp();
      window.removeEventListener('mousemove', moveHandler);
      window.removeEventListener('mouseup', upHandler);
      container.removeEventListener('scroll', scrollHandler);
    };

    window.addEventListener('mousemove', moveHandler);
    window.addEventListener('mouseup', upHandler);
    container.addEventListener('scroll', scrollHandler);
  }

  private _onMouseMove(event: MouseEvent): void {
    if (!this.lassoActive()) return;

    const container =
      this.layout() === 'grid'
        ? this.gridContainer?.nativeElement
        : this.listContainer?.nativeElement;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    let currentX = event.clientX - rect.left + container.scrollLeft;
    let currentY = event.clientY - rect.top + container.scrollTop;

    // Clamp to container boundaries to prevent "growing" the scroll area
    // Width is constrained to clientWidth since we don't want horizontal scroll
    currentX = Math.max(0, Math.min(currentX, container.clientWidth));
    currentY = Math.max(0, Math.min(currentY, container.scrollHeight));

    const width = Math.abs(this._lassoStart.x - currentX);
    const height = Math.abs(this._lassoStart.y - currentY);
    const left = Math.min(this._lassoStart.x, currentX);
    const top = Math.min(this._lassoStart.y, currentY);

    if (width > 5 || height > 5) {
      this._isLassoing = true;
    }

    // Determine visual rectangle relative to paneWrapper
    const parent = this.paneWrapper?.nativeElement;
    if (parent) {
      const parentRect = parent.getBoundingClientRect();
      const visualLeft = left - container.scrollLeft + rect.left - parentRect.left;
      const visualTop = top - container.scrollTop + rect.top - parentRect.top;
      this.lassoRect.set({ left: visualLeft, top: visualTop, width, height });
    }

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
  }

  protected onContainerClick(event: MouseEvent): void {
    if (this._lassoJustFinished) {
      event.stopPropagation();
      return;
    }
    this.clearSelection.emit();
  }

  private _handleAutoScroll(event: MouseEvent, container: HTMLElement): void {
    const rect = container.getBoundingClientRect();
    const threshold = 40;
    let scrollY = 0;

    if (event.clientY < rect.top + threshold) scrollY = -15;
    else if (event.clientY > rect.bottom - threshold) scrollY = 15;

    this._stopAutoScroll();
    if (scrollY !== 0) {
      this._autoScrollTimer = setInterval(() => {
        container.scrollBy(0, scrollY);
        this._updateLassoSelection();
      }, 16);
    }
  }

  private _stopAutoScroll(): void {
    if (this._autoScrollTimer) {
      clearInterval(this._autoScrollTimer);
      this._autoScrollTimer = undefined;
    }
  }

  private _updateLassoSelection(): void {
    const container =
      this.layout() === 'grid'
        ? this.gridContainer?.nativeElement
        : this.listContainer?.nativeElement;
    if (!container) return;

    const parent = this.paneWrapper?.nativeElement;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const lasso = this.lassoRect();

    // lasso is relative to parent, parent is relative to viewport.
    // So lassoViewport is just lasso + parentRect.
    const lassoViewport = {
      left: lasso.left + parentRect.left,
      top: lasso.top + parentRect.top,
      right: lasso.left + parentRect.left + lasso.width,
      bottom: lasso.top + parentRect.top + lasso.height,
    };

    const newSelection = new Set<string>();
    const selector = this.layout() === 'grid' ? '.grid-item' : 'tr.mat-mdc-row';
    const items = container.querySelectorAll(selector);

    items.forEach((itemEl: Element) => {
      const el = itemEl as HTMLElement;
      const itemKey = el.getAttribute('data-item-key');
      if (!itemKey) return;

      const itemRect = el.getBoundingClientRect();

      const intersect = !(
        lassoViewport.left > itemRect.right ||
        lassoViewport.right < itemRect.left ||
        lassoViewport.top > itemRect.bottom ||
        lassoViewport.bottom < itemRect.top
      );

      if (intersect) {
        newSelection.add(itemKey);
      }
    });

    // Check if selection actually changed to avoid unnecessary emits
    const current = this.selection();
    const isDifferent =
      newSelection.size !== current.size ||
      [...newSelection].some(k => !current.has(k)) ||
      [...current].some(k => !newSelection.has(k));

    if (isDifferent) {
      this.updateSelection.emit(newSelection);
    }
  }

  ngOnDestroy(): void {
    this._stopAutoScroll();
  }
}
