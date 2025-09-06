import { Component, Input, ChangeDetectionStrategy } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { AppTab } from '@app/types';

@Component({
  selector: 'app-overview-header',
  standalone: true,
  imports: [MatIconModule],
  templateUrl: './overview-header.component.html',
  styleUrl: './overview-header.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OverviewHeaderComponent {
  @Input() mode: AppTab = 'general';

  get title(): string {
    switch (this.mode) {
      case 'mount':
        return 'Mount Overview';
      case 'sync':
        return 'Sync Overview';
      case 'files':
        return 'Files Overview';
      default:
        return 'Remotes Overview';
    }
  }
}
