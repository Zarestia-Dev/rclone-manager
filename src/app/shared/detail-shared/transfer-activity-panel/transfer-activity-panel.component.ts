import { Component, input, output, ChangeDetectionStrategy, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTabsModule } from '@angular/material/tabs';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe } from '@ngx-translate/core';

import { ActiveTransfersTableComponent } from './active-transfers-table.component';
import { CompletedTransfersTableComponent } from './completed-transfers-table.component';
import { CheckResultsTableComponent } from './check-results-table.component';
import { SearchContainerComponent } from '../../components/search-container/search-container.component';
import { TransferActivityPanelConfig } from '@app/types';

@Component({
  selector: 'app-transfer-activity-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatCardModule,
    MatIconModule,
    MatTabsModule,
    MatButtonModule,
    TranslatePipe,
    ActiveTransfersTableComponent,
    CompletedTransfersTableComponent,
    CheckResultsTableComponent,
    SearchContainerComponent,
  ],
  templateUrl: './transfer-activity-panel.component.html',
  styleUrl: './transfer-activity-panel.component.scss',
})
export class TransferActivityPanelComponent {
  readonly config = input.required<TransferActivityPanelConfig>();
  readonly isJobRunning = input<boolean>(false);
  readonly resetStats = output<void>();
  readonly deleteJob = output<void>();

  readonly searchVisible = signal(false);
  readonly searchTerm = signal('');

  toggleSearch(): void {
    const nextVal = !this.searchVisible();
    this.searchVisible.set(nextVal);
    if (!nextVal) this.searchTerm.set('');
  }
}
