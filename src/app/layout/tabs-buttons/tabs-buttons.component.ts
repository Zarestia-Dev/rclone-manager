import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AppTab } from '@app/types';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';

@Component({
  selector: 'app-tabs',
  imports: [MatIconModule, MatButtonModule, MatTooltipModule, TranslatePipe],
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
    { id: 'operations', icon: 'operations', label: 'tabs.operations' },
    { id: 'serve', icon: 'satellite-dish', label: 'tabs.serve' },
  ];

  setTab(tab: AppTab): void {
    this.uiStateService.setTab(tab);
  }
}
