import { Component, EventEmitter, Input, Output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslateModule } from '@ngx-translate/core';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AppTab } from '@app/types';

@Component({
  selector: 'app-tabs-buttons',
  imports: [MatIconModule, MatButtonModule, MatTooltipModule, TranslateModule],
  templateUrl: './tabs-buttons.component.html',
  styleUrl: './tabs-buttons.component.scss',
})
export class TabsButtonsComponent {
  @Input() currentTab: AppTab = 'general';
  @Output() tabSelected = new EventEmitter<AppTab>();
}
