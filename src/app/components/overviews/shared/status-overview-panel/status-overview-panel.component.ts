import { CommonModule } from '@angular/common';
import { Component, Input, ChangeDetectionStrategy } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { AppTab } from '../../../../shared/components/types';

@Component({
  selector: 'app-status-overview-panel',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatIconModule,
  ],
  templateUrl: './status-overview-panel.component.html',
  styleUrl: './status-overview-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StatusOverviewPanelComponent {
  @Input() mode: AppTab = 'general';
  @Input() totalCount = 0;
  @Input() activeCount = 0;
  @Input() inactiveCount = 0;
  @Input() errorCount = 0;

  get title(): string {
    const mode = this.mode.charAt(0).toUpperCase() + this.mode.slice(1);
    return `${mode} Status Overview`;
  }

  get activeLabel(): string {
    switch (this.mode) {
      case 'mount':
        return 'Mounted';
      case 'sync':
        return 'Syncing';
      case 'copy':
        return 'Copying';
      default:
        return 'Active';
    }
  }

  get inactiveLabel(): string {
    switch (this.mode) {
      case 'mount':
        return 'Unmounted';
      case 'sync':
        return 'Off Sync';
      case 'copy':
        return 'Not Copying';
      default:
        return 'Inactive';
    }
  }

  get activePercentage(): number {
    return this.totalCount > 0 ? (this.activeCount / this.totalCount) * 100 : 0;
  }

  get inactivePercentage(): number {
    return this.totalCount > 0 ? (this.inactiveCount / this.totalCount) * 100 : 0;
  }

  get errorPercentage(): number {
    return this.totalCount > 0 ? (this.errorCount / this.totalCount) * 100 : 0;
  }

  get hasData(): boolean {
    return this.activeCount > 0 || this.inactiveCount > 0 || this.errorCount > 0;
  }
}
