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

import { Origin, ServeListItem, getExecutionOrigin } from '@app/types';
import { ServeCardComponent } from '../../components/serve-card/serve-card.component';
import { ServeManagementService } from '../../../services/operations/serve-management.service';
import { OriginFilterBarComponent } from '../origin-filter-bar/origin-filter-bar.component';

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
  ],
  templateUrl: './serves-overview-panel.component.html',
  styleUrls: ['./serves-overview-panel.component.scss'],
})
export class ServesOverviewPanelComponent {
  readonly expanded = model<boolean>(false);
  readonly hideToggle = input<boolean>(false);

  readonly serves = input<ServeListItem[] | undefined>(undefined);
  readonly defaultOriginFilter = input<Origin | Origin[] | 'all'>('all');
  readonly showFilterChips = input<boolean>(false);

  readonly serveClick = output<ServeListItem>();
  readonly stopServe = output<ServeListItem>();

  private readonly serveService = inject(ServeManagementService);

  readonly selectedOriginFilter = linkedSignal<string>(() => {
    const def = this.defaultOriginFilter();
    if (typeof def === 'string') return def;
    if (Array.isArray(def) && def.length > 0) return def[0];
    return 'all';
  });

  readonly rawServes = computed(() => this.serves() ?? this.serveService.runningServes());

  readonly allServes = computed(() => {
    const all = this.rawServes();
    const filter = this.selectedOriginFilter();
    if (filter === 'all') return all;

    return all.filter(s => getExecutionOrigin(s) === filter);
  });

  onServeClick(serve: ServeListItem): void {
    this.serveClick.emit(serve);
  }

  onStopServe(serve: ServeListItem): void {
    this.stopServe.emit(serve);
  }
}
