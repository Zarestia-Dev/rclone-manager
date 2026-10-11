import {
  Component,
  input,
  output,
  viewChild,
  afterRenderEffect,
  ElementRef,
  ChangeDetectionStrategy,
  signal,
  computed,
  inject,
  OnDestroy,
  effect,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatDividerModule } from '@angular/material/divider';
import { CdkMenuModule } from '@angular/cdk/menu';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { NautilusService } from 'src/app/services/ui/nautilus.service';
import { ScrollShadowDirective } from '../../../shared/directives/scroll-shadow.directive';

import { NautilusTabItem } from '@app/types';

interface TabViewModel {
  tab: NautilusTabItem;
  index: number;
  transform: string;
  tooltip: string;
}

@Component({
  selector: 'app-nautilus-tabs',
  imports: [MatIconModule, MatDividerModule, CdkMenuModule, TranslatePipe, ScrollShadowDirective],
  templateUrl: './nautilus-tabs.component.html',
  styleUrl: './nautilus-tabs.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NautilusTabsComponent implements OnDestroy {
  // --- Services ---
  private readonly translate = inject(TranslateService);
  private readonly nautilusService = inject(NautilusService);

  // --- Inputs ---
  readonly tabs = input.required<NautilusTabItem[]>();
  readonly activeTabIndex = input.required<number>();
  readonly isDragging = input<boolean>(false);
  readonly hoveredTabIndex = input<number | null>(null);

  // --- Outputs ---
  readonly switchTab = output<number>();
  readonly closeTab = output<number>();
  readonly moveTab = output<{ previousIndex: number; currentIndex: number }>();
  readonly duplicateTab = output<number>();
  readonly closeOtherTabs = output<number>();
  readonly closeTabsToRight = output<number>();

  // --- Drag state ---
  protected readonly _draggedTabIndex = signal<number | null>(null);
  protected readonly _insertAtIndex = signal<number | null>(null);
  protected readonly _isDraggedOutside = signal(false);
  private _dragStartPos = { x: 0, y: 0 };
  private _draggedTabWidth = 0;
  private _pointerDrag: {
    pointerId: number;
    tabId: number;
    tabIds: number[];
    index: number;
    centers: number[];
    scrollLeft: number;
  } | null = null;
  private _dragGhost: HTMLElement | null = null;
  private _captureElement: HTMLElement | null = null;
  private _ghostOffset = { x: 0, y: 0 };
  private _ignoreClick = false;
  private _destroyed = false;
  private _scrollFrame: number | null = null;
  private readonly _detachingTabs = new Set<number>();

  // --- Scroll shadow state ---
  protected readonly showLeft = signal(false);
  protected readonly showRight = signal(false);

  readonly tabViewModels = computed<TabViewModel[]>(() =>
    this.tabs().map((tab, index) => ({
      tab,
      index,
      transform: this.getTabTransform(index),
      tooltip: this.getTabTooltip(tab),
    }))
  );

  private readonly tabsScrollContainer =
    viewChild<ElementRef<HTMLDivElement>>('tabsScrollContainer');

  constructor() {
    effect(() => {
      const ids = this.tabs().map(tab => tab.id);
      const pending = this._pointerDrag;
      if (
        pending &&
        (ids.length !== pending.tabIds.length || ids.some((id, i) => id !== pending.tabIds[i]))
      ) {
        this.cancelPointerDrag();
      }
    });
    afterRenderEffect(() => {
      const activeIndex = this.activeTabIndex();
      this.tabs();
      this.scrollToActiveTab(activeIndex);
    });
  }

  ngOnDestroy(): void {
    this._destroyed = true;
    this.cancelPointerDrag();
  }

  // ---------------------------------------------------------------------------
  // Sliding animation
  // ---------------------------------------------------------------------------
  protected getTabTransform(index: number): string {
    const dragged = this._draggedTabIndex();
    const insertAt = this._insertAtIndex();
    const isOutside = this._isDraggedOutside();

    if (dragged === null) {
      return '';
    }

    const w = this._draggedTabWidth;

    if (isOutside) {
      if (index === dragged) return 'scale(0)';
      return '';
    }

    if (insertAt === null || dragged === insertAt) {
      return '';
    }

    // Shift the tab being dragged to its target position
    if (index === dragged) {
      return `translateX(${(insertAt - dragged) * w}px)`;
    }

    // Shift other tabs to fill the gap
    if (dragged < insertAt) {
      if (index > dragged && index <= insertAt) return `translateX(-${w}px)`;
    } else {
      if (index >= insertAt && index < dragged) return `translateX(${w}px)`;
    }

    return '';
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  protected onTabMiddleClick(event: MouseEvent, index: number): void {
    if (event.button === 1) {
      event.preventDefault();
      this.closeTab.emit(index);
    }
  }

  protected onTabClick(index: number): void {
    if (!this._ignoreClick) this.switchTab.emit(index);
  }

  protected onTabPointerDown(event: PointerEvent, tab: NautilusTabItem, index: number): void {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    this.cancelPointerDrag();
    const container = this.tabsScrollContainer()?.nativeElement;
    if (!container) return;
    const elements = Array.from(container.querySelectorAll<HTMLElement>('[data-tab-index]'));
    this._pointerDrag = {
      pointerId: event.pointerId,
      tabId: tab.id,
      tabIds: this.tabs().map(item => item.id),
      index,
      centers: elements.map(element => {
        const rect = element.getBoundingClientRect();
        return rect.left + rect.width / 2;
      }),
      scrollLeft: container.scrollLeft,
    };
    this._dragStartPos = { x: event.clientX, y: event.clientY };
    const element = event.currentTarget as HTMLElement;
    const tabRect = element.getBoundingClientRect();
    this._ghostOffset = { x: event.clientX - tabRect.left, y: event.clientY - tabRect.top };
    this._draggedTabWidth = tabRect.width;
    this._captureElement = element;
    element.setPointerCapture?.(event.pointerId);
    if (elements[index + 1]) {
      this._draggedTabWidth =
        elements[index + 1].getBoundingClientRect().left - element.getBoundingClientRect().left;
    }
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerCancel);
    window.addEventListener('lostpointercapture', this.onPointerCancel);
    window.addEventListener('blur', this.cancelPointerDrag);
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const pending = this._pointerDrag;
    if (!pending || event.pointerId !== pending.pointerId) return;
    if (this._draggedTabIndex() === null) {
      if (
        Math.hypot(event.clientX - this._dragStartPos.x, event.clientY - this._dragStartPos.y) < 8
      )
        return;
      const tab = this.tabs().find(item => item.id === pending.tabId);
      if (!tab) return;
      this._draggedTabIndex.set(pending.index);
      this._dragGhost = this.buildTabDragGhost(tab);
      document.documentElement.appendChild(this._dragGhost);
      if (typeof this._dragGhost.showPopover === 'function') {
        this._dragGhost.popover = 'manual';
        this._dragGhost.showPopover();
      }
    }
    event.preventDefault();
    if (this._dragGhost) {
      this._dragGhost.style.transform = `translate(${event.clientX - this._ghostOffset.x}px, ${event.clientY - this._ghostOffset.y}px)`;
    }
    const container = this.tabsScrollContainer()?.nativeElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const outside =
      event.clientY < rect.top ||
      event.clientY > rect.bottom ||
      event.clientX < rect.left ||
      event.clientX > rect.right;
    this._isDraggedOutside.set(
      event.clientY < rect.top - 32 ||
        event.clientY > rect.bottom + 32 ||
        event.clientX < rect.left - 32 ||
        event.clientX > rect.right + 32
    );
    if (outside) {
      if (this._scrollFrame !== null) cancelAnimationFrame(this._scrollFrame);
      this._scrollFrame = null;
      return;
    }
    const x = event.clientX + container.scrollLeft - pending.scrollLeft;
    let target = pending.index;
    pending.centers.forEach((center, index) => {
      if (index < pending.index && x < center) target = Math.min(target, index);
      if (index > pending.index && x > center) target = Math.max(target, index);
    });
    this._insertAtIndex.set(target);
    if (this._scrollFrame !== null) cancelAnimationFrame(this._scrollFrame);
    this._scrollFrame = null;
    const direction = event.clientX < rect.left + 24 ? -1 : event.clientX > rect.right - 24 ? 1 : 0;
    if (direction !== 0) {
      this._scrollFrame = requestAnimationFrame(() => {
        this._scrollFrame = null;
        const previous = container.scrollLeft;
        container.scrollLeft += direction * 12;
        if (container.scrollLeft !== previous) this.onPointerMove(event);
      });
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const pending = this._pointerDrag;
    if (!pending || event.pointerId !== pending.pointerId) return;
    const started = this._draggedTabIndex() !== null;
    if (started) this.onPointerMove(event);
    const target = this._insertAtIndex();
    const detach = this._isDraggedOutside();
    const rect = this.tabsScrollContainer()?.nativeElement.getBoundingClientRect();
    const inside =
      rect &&
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    this.cancelPointerDrag();
    if (!started) return;
    this._ignoreClick = true;
    setTimeout(() => (this._ignoreClick = false), 0);
    if (detach) {
      void this.detachTabAction(pending.index);
    } else if (inside && target !== null && target !== pending.index) {
      this.moveTab.emit({ previousIndex: pending.index, currentIndex: target });
    }
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerId === this._pointerDrag?.pointerId) this.cancelPointerDrag();
  };

  private readonly cancelPointerDrag = (): void => {
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerCancel);
    window.removeEventListener('lostpointercapture', this.onPointerCancel);
    window.removeEventListener('blur', this.cancelPointerDrag);
    const pointerId = this._pointerDrag?.pointerId;
    this._pointerDrag = null;
    if (pointerId !== undefined && this._captureElement?.hasPointerCapture?.(pointerId)) {
      this._captureElement.releasePointerCapture(pointerId);
    }
    this._captureElement = null;
    if (this._scrollFrame !== null) cancelAnimationFrame(this._scrollFrame);
    this._scrollFrame = null;
    this._dragGhost?.remove();
    this._dragGhost = null;
    this._draggedTabIndex.set(null);
    this._insertAtIndex.set(null);
    this._isDraggedOutside.set(false);
  };

  protected async detachTabAction(index: number): Promise<void> {
    const tab = this.tabs()[index];
    if (!tab || this._detachingTabs.has(tab.id)) return;
    this._detachingTabs.add(tab.id);
    try {
      const opened = await this.nautilusService.openStandaloneWindow(
        tab.remote?.name ?? null,
        tab.path ?? null
      );
      if (!opened) return;
      const currentIndex = this.tabs().findIndex(item => item.id === tab.id);
      if (!this._destroyed && currentIndex >= 0) this.closeTab.emit(currentIndex);
    } catch (err) {
      console.error('Failed to detach tab:', err);
    } finally {
      this._detachingTabs.delete(tab.id);
    }
  }

  protected getTabTooltip(t: NautilusTabItem): string {
    const prefix = t.remote ? `${this.translate.instant(t.remote.label)}:` : '';
    return `${prefix}${t.path}`;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private scrollToActiveTab(index: number): void {
    const container = this.tabsScrollContainer()?.nativeElement;
    if (!container) return;

    const activeTab = container.querySelector<HTMLElement>(`[data-tab-index="${index}"]`);
    if (!activeTab) return;

    const containerRect = container.getBoundingClientRect();
    const tabRect = activeTab.getBoundingClientRect();

    if (tabRect.left < containerRect.left || tabRect.right > containerRect.right) {
      activeTab.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }

  private buildTabDragGhost(tab: NautilusTabItem): HTMLElement {
    const ghost = document.createElement('div');
    ghost.classList.add('truncate');
    ghost.setAttribute('aria-hidden', 'true');
    Object.assign(ghost.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      margin: '0',
      border: 'none',
      boxSizing: 'border-box',
      width: `${this._captureElement?.getBoundingClientRect().width ?? this._draggedTabWidth}px`,
      pointerEvents: 'none',
      zIndex: '2147483647',
      padding: 'var(--space-xs) var(--space-md)',
      background: 'var(--popover-bg-color)',
      boxShadow: 'var(--box-shadow)',
      color: 'var(--window-fg-color)',
      borderRadius: 'var(--radius-sm)',
      fontSize: 'var(--font-size-md)',
      fontWeight: '600',
      whiteSpace: 'nowrap',
      fontFamily: 'Inter, system-ui, sans-serif',
    });
    ghost.textContent = this.translate.instant(tab.title) || tab.title;
    return ghost;
  }
}
