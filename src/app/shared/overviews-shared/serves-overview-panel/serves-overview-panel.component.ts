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

import { Origin, ServeListItem, matchesOriginFilter } from '@app/types';
import { ServeCardComponent } from '../../components/serve-card/serve-card.component';
import { ServeManagementService } from '../../../services/operations/serve-management.service';
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
  readonly expanded = model<boolean>(false);

  readonly defaultOriginFilter = input<Origin | 'all'>('all');
  readonly showFilterChips = input<boolean>(false);

  readonly serveClick = output<ServeListItem>();
  readonly stopServe = output<ServeListItem>();

  private readonly serveService = inject(ServeManagementService);

  readonly selectedOriginFilter = linkedSignal<string>(() => this.defaultOriginFilter());

  readonly allServes = computed(() => {
    const filter = this.selectedOriginFilter();
    return this.serveService.runningServes().filter(s => matchesOriginFilter(s, filter));
  });

  onServeClick(serve: ServeListItem): void {
    this.serveClick.emit(serve);
  }

  onStopServe(serve: ServeListItem): void {
    this.stopServe.emit(serve);
  }
}
