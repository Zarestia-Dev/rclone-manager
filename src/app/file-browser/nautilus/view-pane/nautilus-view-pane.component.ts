import { Component, input, output, inject, TemplateRef, computed, signal } from '@angular/core';
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
export class NautilusViewPaneComponent {
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

    const isMulti = this._isMultiDrag(item);
    const anchorX = GHOST_CARD_W / 2;
    const anchorY = (isMulti ? GHOST_BG_CARDS * GHOST_STACK_OFFSET : 0) + GHOST_CARD_H / 2;
    event.dataTransfer?.setDragImage(ghost, anchorX, anchorY);

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
}
