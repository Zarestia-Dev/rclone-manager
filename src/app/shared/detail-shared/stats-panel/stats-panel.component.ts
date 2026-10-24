import { Component, ChangeDetectionStrategy, computed, input } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { TranslatePipe } from '@ngx-translate/core';
import { StatsPanelConfig } from '@app/types';

@Component({
  selector: 'app-stats-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, MatIconModule, MatProgressBarModule, TranslatePipe],
  styleUrls: ['./stats-panel.component.scss'],
  templateUrl: './stats-panel.component.html',
})
export class StatsPanelComponent {
  readonly config = input.required<StatsPanelConfig>();

  readonly hasActiveStats = computed(
    () =>
      this.config().stats?.some(stat => {
        if (stat.hasError) return true;
        if (stat.progress && stat.progress > 0) return true;
        return stat.value ?? '';
      }) ?? false
  );
}
