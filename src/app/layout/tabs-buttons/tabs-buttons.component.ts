import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslateModule } from '@ngx-translate/core';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AppTab } from '@app/types';
import { UiStateService } from '@app/services';

@Component({
  selector: 'app-tabs',
  standalone: true,
  imports: [MatIconModule, MatButtonModule, MatTooltipModule, TranslateModule],
  templateUrl: './tabs-buttons.component.html',
  styleUrl: './tabs-buttons.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TabsButtonsComponent {
  private readonly uiStateService = inject(UiStateService);

  readonly currentTab = this.uiStateService.currentTab;

  readonly tabs: { id: AppTab; icon: string; label: string }[] = [
    { id: 'general', icon: 'home', label: 'tabs.general' },
    { id: 'mount', icon: 'mount', label: 'tabs.mount' },
    { id: 'sync', icon: 'sync', label: 'tabs.sync' },
    { id: 'serve', icon: 'satellite-dish', label: 'tabs.serve' },
  ];

  setTab(tab: AppTab): void {
    this.uiStateService.setTab(tab);
  }
}
