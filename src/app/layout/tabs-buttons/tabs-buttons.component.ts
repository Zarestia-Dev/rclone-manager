import { Component, ChangeDetectionStrategy, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslateModule } from '@ngx-translate/core';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AppTab } from '@app/types';

@Component({
  selector: 'app-tabs-buttons',
  standalone: true,
  imports: [MatIconModule, MatButtonModule, MatTooltipModule, TranslateModule],
  templateUrl: './tabs-buttons.component.html',
  styleUrl: './tabs-buttons.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TabsButtonsComponent {
  currentTab = input<AppTab>('general');
  tabSelected = output<AppTab>();

  readonly tabs: { id: AppTab; icon: string; label: string }[] = [
    { id: 'general', icon: 'home', label: 'tabs.general' },
    { id: 'mount', icon: 'mount', label: 'tabs.mount' },
    { id: 'sync', icon: 'sync', label: 'tabs.sync' },
    { id: 'serve', icon: 'satellite-dish', label: 'tabs.serve' },
  ];
}
