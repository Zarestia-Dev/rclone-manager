import { Component, ChangeDetectionStrategy, inject, input, output, computed } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { MatButtonModule } from '@angular/material/button';
import { AppTab, TabItem } from '@app/types';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';

@Component({
  selector: 'app-tabs',
  imports: [MatIconModule, MatButtonModule, TranslatePipe],
  templateUrl: './tabs-buttons.component.html',
  styleUrl: './tabs-buttons.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.mobile-hidden]': 'isMobileHidden()',
  },
})
export class TabsButtonsComponent<T extends string = string> {
  protected readonly uiStateService = inject(UiStateService);

  readonly customTabs = input<TabItem<T>[]>();
  readonly activeTab = input<T | string>();
  readonly activeTabChange = output<T>();
  readonly mobileHidden = input<boolean>();

  private readonly defaultTabs: TabItem<AppTab>[] = [
    { id: 'general', icon: 'home', label: 'tabs.general' },
    { id: 'mount', icon: 'mount', label: 'tabs.mount' },
    { id: 'operations', icon: 'operations', label: 'tabs.operations' },
    { id: 'serve', icon: 'satellite-dish', label: 'tabs.serve' },
  ];

  readonly tabs = computed(() => (this.customTabs() ?? this.defaultTabs) as TabItem<T>[]);
  readonly currentTab = computed(() => this.activeTab() ?? this.uiStateService.currentTab());
  readonly isMobileHidden = computed(
    () => this.mobileHidden() ?? this.uiStateService.mobileSidebarOpen()
  );

  setTab(tabId: T): void {
    if (this.customTabs()) {
      this.activeTabChange.emit(tabId);
    } else {
      this.uiStateService.setTab(tabId as unknown as AppTab);
      this.activeTabChange.emit(tabId);
    }
  }
}
