import {
  Component,
  input,
  output,
  viewChild,
  afterRenderEffect,
  ElementRef,
  ChangeDetectionStrategy,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDividerModule } from '@angular/material/divider';
import { CdkMenuModule } from '@angular/cdk/menu';
import { DragDropModule, CdkDragDrop, CdkDrag } from '@angular/cdk/drag-drop';
import { TranslateModule } from '@ngx-translate/core';

export interface TabItem {
  id: number;
  title: string;
  path: string;
  remote: { label: string } | null;
}

@Component({
  selector: 'app-nautilus-tabs',
  standalone: true,
  imports: [
    MatIconModule,
    MatTooltipModule,
    MatDividerModule,
    CdkMenuModule,
    DragDropModule,
    TranslateModule,
  ],
  templateUrl: './nautilus-tabs.component.html',
  styleUrls: ['./nautilus-tabs.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NautilusTabsComponent {
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

  private readonly tabsScrollContainer =
    viewChild<ElementRef<HTMLDivElement>>('tabsScrollContainer');

  constructor() {
    afterRenderEffect(() => {
      this.scrollToActiveTab(this.activeTabIndex());
    });
  }

  protected onTabClick(index: number): void {
    this.switchTab.emit(index);
  }

  protected onTabMiddleClick(event: MouseEvent, index: number): void {
    if (event.button === 1) {
      event.preventDefault();
      this.closeTab.emit(index);
    }
  }

  protected onCloseTab(event: MouseEvent, index: number): void {
    event.stopPropagation();
    this.closeTab.emit(index);
  }

  protected onDrop(event: CdkDragDrop<TabItem[]>): void {
    this.moveTab.emit({
      previousIndex: event.previousIndex,
      currentIndex: event.currentIndex,
    });
  }

  readonly rejectFileDrags = (item: CdkDrag): boolean => {
    return item.data?.entry?.Path === undefined;
  };

  protected onWheelScroll(event: WheelEvent): void {
    const container = this.tabsScrollContainer()?.nativeElement;
    if (container) {
      container.scrollLeft += event.deltaY;
      event.preventDefault();
    }
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
}
