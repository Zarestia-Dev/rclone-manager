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

  private readonly TITLE_MAP: Record<string, string> = {
    mount: 'Mount Overview',
    sync: 'Sync Overview',
    serve: 'Serve Overview',
  };

  get title(): string {
    return this.TITLE_MAP[this.mode] || 'Remotes Overview';
  }
}
