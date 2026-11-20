import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  model,
  output,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';

import { Automation, Origin, matchesOriginFilter, PANEL_TONE } from '@app/types';
import { AutomationCardComponent } from '../../detail-shared/automation-card/automation-card.component';
import { AutomationService } from '../../../services/operations/automation.service';
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

  readonly defaultOriginFilter = input<Origin | 'all'>('all');
  readonly showFilterChips = input<boolean>(false);

  readonly automationClick = output<Automation>();

  private readonly automationService = inject(AutomationService);

  readonly selectedOriginFilter = linkedSignal<string>(() => this.defaultOriginFilter());

  readonly allAutomations = computed(() => {
    const filter = this.selectedOriginFilter();
    return this.automationService
      .automations()
      .filter(automation => matchesOriginFilter({ origin: automation.args?.source }, filter));
  });

  readonly totalCount = computed(() => this.allAutomations().length);
  readonly activeCount = computed(
    () => this.allAutomations().filter(t => t.status === 'enabled' || t.status === 'running').length
  );

  onAutomationCardClick(automation: Automation): void {
    this.automationClick.emit(automation);
  }
}
