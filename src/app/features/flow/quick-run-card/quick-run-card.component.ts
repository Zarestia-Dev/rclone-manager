import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';

import { OPERATION_REGISTRY, QuickRun, QuickRunStatus } from '@app/types';

/**
 * A card component for Quick Runs, supporting two visual variants:
 *  - 'sidebar': Compact item designed for the Flow sidebar list.
 *  - 'overview': Dashboard card with direct Start/Stop and Edit actions.
 */
@Component({
  selector: 'app-quick-run-card',
  imports: [MatButtonModule, MatCardModule, MatIconModule, TranslatePipe],
  templateUrl: './quick-run-card.component.html',
  styleUrl: './quick-run-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuickRunCardComponent {
  /** The quick run this card represents. */
  readonly quickRun = input.required<QuickRun>();
  /** True if this card is currently selected (drives highlight). */
  readonly selected = input<boolean>(false);
  /** True if the quick run is currently running (drives status dot/badge). */
  readonly isRunning = input<boolean>(false);
  /** Visual variant: 'sidebar' for compact list, 'overview' for dashboard card grid. */
  readonly variant = input<'sidebar' | 'overview'>('sidebar');

  /** Emitted when the card is clicked (selects quick run for detail view). */
  readonly selectedChange = output<string>();
  /** Emitted when the Start action button is clicked (overview variant). */
  readonly startRun = output<QuickRun>();
  /** Emitted when the Stop action button is clicked (overview variant). */
  readonly stopRun = output<QuickRun>();
  /** Emitted when the Edit action button is clicked (overview variant). */
  readonly editRun = output<QuickRun>();

  // ── Derived view model ────────────────────────────────────────────────────

  readonly operationDef = computed(() => {
    const op = this.quickRun().operationType;
    return OPERATION_REGISTRY.find(d => d.key === op);
  });

  readonly icon = computed(() => this.operationDef()?.icon ?? 'operations');
  readonly actionLabel = computed(() => this.operationDef()?.actionLabel ?? 'Start');

  /** Status badge metadata (label + color class). */
  readonly statusBadge = computed<{ cssClass: QuickRunStatus }>(() => {
    const status: QuickRunStatus = this.isRunning() ? 'running' : this.quickRun().status;
    return { cssClass: status };
  });

  /** Feature indicators (Cron schedule, File Watcher, AutoStart). */
  readonly hasCron = computed(() => {
    const app = this.quickRun().config?.app;
    return !!(app?.cronEnabled && app?.cronExpression);
  });

  readonly cronExpression = computed(() => this.quickRun().config?.app?.cronExpression ?? '');

  readonly hasWatcher = computed(() => {
    const app = this.quickRun().config?.app;
    return !!app?.watchEnabled;
  });

  readonly hasAutoStart = computed(() => {
    const app = this.quickRun().config?.app;
    return !!app?.autoStart;
  });

  // ── Actions ───────────────────────────────────────────────────────────────

  onRowClick(): void {
    this.selectedChange.emit(this.quickRun().id);
  }

  onStart(event: MouseEvent): void {
    event.stopPropagation();
    this.startRun.emit(this.quickRun());
  }

  onStop(event: MouseEvent): void {
    event.stopPropagation();
    this.stopRun.emit(this.quickRun());
  }

  onEdit(event: MouseEvent): void {
    event.stopPropagation();
    this.editRun.emit(this.quickRun());
  }
}
