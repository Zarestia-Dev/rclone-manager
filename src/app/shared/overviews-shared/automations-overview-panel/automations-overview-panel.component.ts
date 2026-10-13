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

import { Automation, Origin } from '@app/types';
import { AutomationCardComponent } from '../../detail-shared/automation-card/automation-card.component';
import { AutomationService } from 'src/app/services/operations/automation.service';

@Component({
  selector: 'app-automations-overview-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatExpansionModule, MatIconModule, TranslatePipe, AutomationCardComponent],
  templateUrl: './automations-overview-panel.component.html',
  styleUrls: ['./automations-overview-panel.component.scss'],
})
export class AutomationsOverviewPanelComponent {
  readonly expanded = model<boolean>(false);
  readonly hideToggle = input<boolean>(false);

  readonly automations = input<Automation[] | undefined>(undefined);
  readonly defaultOriginFilter = input<Origin | Origin[] | 'all'>('all');
  readonly showFilterChips = input<boolean>(false);

  readonly automationClick = output<Automation>();
  readonly toggleAutomation = output<string>();
  readonly openInFiles = output<string>();

  private readonly automationService = inject(AutomationService);

  readonly selectedOriginFilter = linkedSignal<string>(() => {
    const def = this.defaultOriginFilter();
    if (typeof def === 'string') return def;
    if (Array.isArray(def) && def.length > 0) return def[0];
    return 'all';
  });

  readonly rawAutomations = computed(() => {
    const provided = this.automations();
    if (provided !== undefined) return provided;
    return this.automationService.automations();
  });

  readonly allAutomations = computed(() => {
    const all = this.rawAutomations();
    const filter = this.selectedOriginFilter();
    if (filter === 'all') return all;
    if (filter === 'flow') {
      return all.filter(t => t.args?.source === 'flow');
    }
    if (filter === 'quickrun') {
      return all.filter(t => t.args?.source === 'quickrun');
    }
    if (filter === 'dashboard' || filter === 'automation') {
      return all.filter(t => t.args?.source !== 'quickrun' && t.args?.source !== 'flow');
    }
    return all.filter(t => t.args?.source === filter);
  });

  readonly totalCount = computed(() => this.allAutomations().length);
  readonly activeCount = computed(
    () => this.allAutomations().filter(t => t.status === 'enabled' || t.status === 'running').length
  );

  onAutomationCardClick(automation: Automation): void {
    this.automationClick.emit(automation);
  }

  onToggleAutomation(automationId: string): void {
    this.toggleAutomation.emit(automationId);
  }

  onOpenInFiles(path: string): void {
    this.openInFiles.emit(path);
  }
}
