import {
  Component,
  input,
  output,
  viewChild,
  afterRenderEffect,
  afterNextRender,
  ElementRef,
  ChangeDetectionStrategy,
  signal,
  inject,
  DestroyRef,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDividerModule } from '@angular/material/divider';
import { CdkMenuModule } from '@angular/cdk/menu';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NautilusService } from '@app/services';

export interface TabItem {
  id: number;
  title: string;
  path: string;
  remote: { name: string; label: string } | null;
}

@Component({
  selector: 'app-nautilus-tabs',
  standalone: true,
  imports: [MatIconModule, MatTooltipModule, MatDividerModule, CdkMenuModule, TranslateModule],
  templateUrl: './nautilus-tabs.component.html',
  styleUrl: './nautilus-tabs.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NautilusTabsComponent {
  // --- Services ---
  private readonly translate = inject(TranslateService);
  private readonly nautilusService = inject(NautilusService);
  private readonly destroyRef = inject(DestroyRef);

  // --- Inputs ---
  readonly tabs = input.required<TabItem[]>();
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
  private _dropSucceeded = false;

  // --- Scroll shadow state ---
  protected readonly _showLeftShadow = signal(false);
  protected readonly _showRightShadow = signal(false);

  private readonly tabsScrollContainer =
    viewChild<ElementRef<HTMLDivElement>>('tabsScrollContainer');

  constructor() {
    afterRenderEffect(() => {
      const activeIndex = this.activeTabIndex();
      this.tabs();
      this.scrollToActiveTab(activeIndex);
      this.updateScrollShadows();
    });

    afterNextRender(() => {
      const el = this.tabsScrollContainer()?.nativeElement;
      if (!el) return;

      el.addEventListener('wheel', this.onWheelScroll, { passive: false });

      const ro = new ResizeObserver(() => this.updateScrollShadows());
      ro.observe(el);

      this.destroyRef.onDestroy(() => {
        el.removeEventListener('wheel', this.onWheelScroll);
        window.removeEventListener('dragover', this.onGlobalDragOver);
        ro.disconnect();
      });
    });
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

  protected onNativeDragStart(event: DragEvent, tab: TabItem, index: number): void {
    this._draggedTabIndex.set(index);
    this._insertAtIndex.set(index);
    this._isDraggedOutside.set(false);
    this._dropSucceeded = false;
    this._dragStartPos = { x: event.clientX, y: event.clientY };

    window.addEventListener('dragover', this.onGlobalDragOver);

    this._draggedTabWidth = (event.currentTarget as HTMLElement).offsetWidth + 4;

    const url = this.nautilusService.getNautilusUrl(tab.remote?.name ?? null, tab.path ?? null);
    const ghost = this.buildTabDragGhost(tab);
    document.body.appendChild(ghost);

    if (event.dataTransfer) {
      event.dataTransfer.setData('text/uri-list', url);
      event.dataTransfer.setData('text/plain', url);
      event.dataTransfer.setData('application/x-nautilus-tab', String(index));
      event.dataTransfer.effectAllowed = 'copyMove';

      event.dataTransfer.setDragImage(ghost, 0, 0);
    }

    requestAnimationFrame(() => ghost.remove());
  }

  protected onNativeDragOver(event: DragEvent, index?: number): void {
    if (this._draggedTabIndex() === null) return;
    this._isDraggedOutside.set(false);
    event.preventDefault();

    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }

    // Determine the logical index to insert at
    let targetIndex = index;

    if (targetIndex === undefined) {
      // If we are over the bar but not a specific tab, calculate based on mouse position
      const bar = event.currentTarget as HTMLElement;
      const rect = bar.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const totalTabs = this.tabs().length;

      if (totalTabs > 0) {
        const avgWidth = rect.width / totalTabs;
        targetIndex = Math.max(0, Math.min(totalTabs - 1, Math.floor(x / avgWidth)));
      }
    }

    if (targetIndex !== undefined && this._insertAtIndex() !== targetIndex) {
      this._insertAtIndex.set(targetIndex);
    }
  }

  protected onNativeDragLeave(event: DragEvent): void {
    const related = event.relatedTarget as Node | null;
    if (related && (event.currentTarget as HTMLElement).contains(related)) return;
  }

  protected onNativeDrop(event: DragEvent, index?: number): void {
    event.preventDefault();

    const previousIndex = this._draggedTabIndex();
    const currentIndex = index !== undefined ? index : this._insertAtIndex();

    if (previousIndex !== null && currentIndex !== null) {
      this._dropSucceeded = true;
      if (previousIndex !== currentIndex) {
        this.moveTab.emit({ previousIndex, currentIndex });
      }
    }

    this._draggedTabIndex.set(null);
    this._insertAtIndex.set(null);
  }

  protected async onNativeDragEnd(event: DragEvent, tab: TabItem, index: number): Promise<void> {
    window.removeEventListener('dragover', this.onGlobalDragOver);

    const succeeded = this._dropSucceeded;
    this._dropSucceeded = false;
    this._isDraggedOutside.set(false);
    this._draggedTabIndex.set(null);
    this._insertAtIndex.set(null);

    if (!succeeded) {
      const isOutside =
        event.clientX < -20 ||
        event.clientY < -20 ||
        event.clientX >= window.innerWidth + 20 ||
        event.clientY >= window.innerHeight + 20;

      const dy = Math.abs(event.clientY - this._dragStartPos.y);
      const isSignificantMove = dy > 70;

      if (isOutside || (event.dataTransfer?.dropEffect !== 'none' && isSignificantMove)) {
        await this.detachTabAction(index);
      }
    }
  }

  protected async detachTabAction(index: number): Promise<void> {
    const tab = this.tabs()[index];
    if (!tab) return;
    try {
      await this.nautilusService.detachTab(tab.remote?.name ?? null, tab.path ?? null);
      this.closeTab.emit(index);
    } catch (err) {
      console.error('Failed to detach tab:', err);
    }
  }

  protected onScroll(): void {
    this.updateScrollShadows();
  }

  protected getTabTooltip(t: TabItem): string {
    const prefix = t.remote ? `${this.translate.instant(t.remote.label)}:` : '';
    return `${prefix}${t.path}`;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private readonly onGlobalDragOver = (event: DragEvent): void => {
    if (this._draggedTabIndex() === null) return;

    const isOutsideWindow =
      event.clientX < -20 ||
      event.clientY < -20 ||
      event.clientX >= window.innerWidth + 20 ||
      event.clientY >= window.innerHeight + 20;

    const dy = Math.abs(event.clientY - this._dragStartPos.y);
    const isDraggedDown = dy > 100;

    this._isDraggedOutside.set(isOutsideWindow || isDraggedDown);
  };

  private readonly onWheelScroll = (event: WheelEvent): void => {
    const container = this.tabsScrollContainer()?.nativeElement;
    if (!container) return;
    container.scrollLeft += event.deltaY;
    event.preventDefault();
  };

  private updateScrollShadows(): void {
    const el = this.tabsScrollContainer()?.nativeElement;
    if (!el) return;
    this._showLeftShadow.set(el.scrollLeft > 4);
    this._showRightShadow.set(el.scrollLeft < el.scrollWidth - el.clientWidth - 4);
  }

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

  private buildTabDragGhost(tab: TabItem): HTMLElement {
    const ghost = document.createElement('div');
    Object.assign(ghost.style, {
      position: 'fixed',
      top: '-9999px',
      left: '-9999px',
      padding: 'var(--space-xs) var(--space-md)',
      background: 'var(--selected-bg-color)',
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
