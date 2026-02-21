import { Component, input, output, effect, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDividerModule } from '@angular/material/divider';
import { CdkMenuModule } from '@angular/cdk/menu';
import { DragDropModule, CdkDragDrop } from '@angular/cdk/drag-drop';
import { TranslateModule } from '@ngx-translate/core';

// Reusing the Tab interface from NautilusComponent or a shared types file.
// Since it's currently defined in nautilus.component.ts, I will declare the minimal subset needed here.
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
    CommonModule,
    MatIconModule,
    MatTooltipModule,
    MatDividerModule,
    CdkMenuModule,
    DragDropModule,
    TranslateModule,
  ],
  templateUrl: './nautilus-tabs.component.html',
  styleUrls: ['./nautilus-tabs.component.scss'],
})
export class NautilusTabsComponent {
  // --- Inputs ---
  public readonly tabs = input.required<any[]>(); // Using any[] to avoid strict import tying for now, but typing it as Tab[] from parent.
  public readonly activeTabIndex = input.required<number>();

  // --- Outputs ---
  public readonly switchTab = output<number>();
  public readonly closeTab = output<number>();
  public readonly moveTab = output<{ previousIndex: number; currentIndex: number }>();
  public readonly duplicateTab = output<number>();
  public readonly closeOtherTabs = output<number>();
  public readonly closeTabsToRight = output<number>();

  public contextTabIndex: number | null = null;
  @ViewChild('tabsScrollContainer') tabsScrollContainer?: ElementRef<HTMLDivElement>;

  constructor() {
    effect(() => {
      // Whenever the active tab changes, we should ensure it's visible in the scroll view
      const idx = this.activeTabIndex();
      setTimeout(() => this.scrollToActiveTab(idx), 50);
    });
  }

  onTabClick(index: number) {
    this.switchTab.emit(index);
  }

  onTabMiddleClick(event: MouseEvent, index: number) {
    if (event.button === 1) {
      event.preventDefault();
      this.closeTab.emit(index);
    }
  }

  onCloseTab(event: MouseEvent, index: number) {
    event.stopPropagation();
    this.closeTab.emit(index);
  }

  onDrop(event: CdkDragDrop<any>) {
    this.moveTab.emit({
      previousIndex: event.previousIndex,
      currentIndex: event.currentIndex,
    });
  }

  onWheelScroll(event: WheelEvent) {
    if (this.tabsScrollContainer?.nativeElement) {
      this.tabsScrollContainer.nativeElement.scrollLeft += event.deltaY;
      event.preventDefault();
    }
  }

  private scrollToActiveTab(index: number) {
    if (!this.tabsScrollContainer?.nativeElement) return;
    const container = this.tabsScrollContainer.nativeElement;
    const activeTabObj = container.children[index] as HTMLElement;
    if (activeTabObj) {
      // Simple logic to center the active tab if it's out of view
      const containerRect = container.getBoundingClientRect();
      const tabRect = activeTabObj.getBoundingClientRect();

      if (tabRect.left < containerRect.left || tabRect.right > containerRect.right) {
        activeTabObj.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      }
    }
  }
}
