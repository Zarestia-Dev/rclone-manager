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

import {
  ServeListItem,
  availableOverviewOrigins,
  matchesOriginFilter,
  PANEL_TONE,
} from '@app/types';
import { ServeCardComponent } from '../../components/serve-card/serve-card.component';
import { ServeManagementService } from '../../../services/operations/serve-management.service';
import { OriginFilterService } from '../../../services/ui/state/origin-filter.service';
import { OriginFilterBarComponent } from '../origin-filter-bar/origin-filter-bar.component';

import { PillDirective } from '../../directives/pill.directive';
@Component({
  selector: 'app-serves-overview-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatExpansionModule,
    MatIconModule,
    TranslatePipe,
    ServeCardComponent,
    OriginFilterBarComponent,
    PillDirective,
  ],
  templateUrl: './serves-overview-panel.component.html',
  styleUrl: '../../../styles/_overview-card-panel.scss',
})
export class ServesOverviewPanelComponent {
  /** The colour role of the panel's icon and count pill. */
  protected readonly tone = PANEL_TONE.serves;
  readonly expanded = model<boolean>(false);

  readonly showFilterChips = input<boolean>(false);

  readonly serveClick = output<ServeListItem>();
  readonly stopServe = output<ServeListItem>();

  private readonly serveService = inject(ServeManagementService);

  protected readonly originFilters = inject(OriginFilterService);

  readonly availableOrigins = computed(() =>
    availableOverviewOrigins(this.serveService.runningServes())
  );

  /** Chips off (the app overview): everything shows, whatever the panel was left on elsewhere. */
  readonly selectedOriginFilter = computed(() =>
    this.showFilterChips() ? this.originFilters.get('serves', this.availableOrigins()) : 'all'
  );

  readonly allServes = computed(() => {
    const filter = this.selectedOriginFilter();
    return this.serveService.runningServes().filter(s => matchesOriginFilter(s, filter));
  });

  /** Every serve, whatever the chip: the header counts what runs, not what the chip shows. */
  readonly totalCount = computed(() => this.serveService.runningServes().length);

  /** Items the origin chip hides. */
  readonly hiddenCount = computed(() => this.totalCount() - this.allServes().length);

  onServeClick(serve: ServeListItem): void {
    this.serveClick.emit(serve);
  }

  onStopServe(serve: ServeListItem): void {
    this.stopServe.emit(serve);
  }
}
