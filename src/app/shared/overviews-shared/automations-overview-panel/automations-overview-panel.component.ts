import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  model,
  output,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';

import { Automation, availableOverviewOrigins, matchesOriginFilter, PANEL_TONE } from '@app/types';
import { AutomationCardComponent } from '../../detail-shared/automation-card/automation-card.component';
import { AutomationService } from '../../../services/operations/automation.service';
import { OriginFilterService } from '../../../services/ui/state/origin-filter.service';
import { OriginFilterBarComponent } from '../origin-filter-bar/origin-filter-bar.component';

import { PillDirective } from '../../directives/pill.directive';
@Component({
  selector: 'app-automations-overview-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatExpansionModule,
    MatIconModule,
    TranslatePipe,
    AutomationCardComponent,
    OriginFilterBarComponent,
    PillDirective,
  ],
  templateUrl: './automations-overview-panel.component.html',
  styleUrl: '../../../styles/_overview-card-panel.scss',
})
export class AutomationsOverviewPanelComponent {
  /** The colour role of the panel's icon and count pill. */
  protected readonly tone = PANEL_TONE.automations;
  readonly expanded = model<boolean>(false);

  readonly showFilterChips = input<boolean>(false);

  readonly automationClick = output<Automation>();

  private readonly automationService = inject(AutomationService);

  protected readonly originFilters = inject(OriginFilterService);

  readonly availableOrigins = computed(() =>
    availableOverviewOrigins(
      this.automationService.automations().map(automation => ({
        origin: automation.args?.source,
      }))
    )
  );

  /** Chips off (the app overview): everything shows, whatever the panel was left on elsewhere. */
  readonly selectedOriginFilter = computed(() =>
    this.showFilterChips() ? this.originFilters.get('automations', this.availableOrigins()) : 'all'
  );

  readonly allAutomations = computed(() => {
    const filter = this.selectedOriginFilter();
    return this.automationService
      .automations()
      .filter(automation => matchesOriginFilter({ origin: automation.args?.source }, filter));
  });

  /** Every automation, whatever the chip: the header counts what is set up, not what the chip shows. */
  readonly totalCount = computed(() => this.automationService.automations().length);
  /**
   * What is running or will run by itself: a schedule, a watcher or a start that waits for its
   * delay. A start with the app that is done is not active until the next start.
   */
  readonly activeCount = computed(
    () =>
      this.automationService
        .automations()
        .filter(
          t =>
            t.status === 'running' ||
            (t.status === 'enabled' && (!!t.cronExpression || t.watchEnabled || !!t.autoStartAt))
        ).length
  );

  /** Items the origin chip hides. */
  readonly hiddenCount = computed(() => this.totalCount() - this.allAutomations().length);

  onAutomationCardClick(automation: Automation): void {
    this.automationClick.emit(automation);
  }
}
