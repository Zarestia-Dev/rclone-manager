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

import { Origin, ServeListItem } from '@app/types';
import { ServeCardComponent } from '../../components/serve-card/serve-card.component';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';

@Component({
  selector: 'app-serves-overview-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatExpansionModule, MatIconModule, TranslatePipe, ServeCardComponent],
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

  private readonly remoteFacade = inject(RemoteFacadeService);
  private readonly quickRunService = inject(QuickRunService);

  readonly selectedOriginFilter = linkedSignal<string>(() => {
    const def = this.defaultOriginFilter();
    if (typeof def === 'string') return def;
    if (Array.isArray(def) && def.length > 0) return def[0];
    return 'all';
  });

  readonly rawServes = computed(() => {
    const provided = this.serves();
    if (provided !== undefined) return provided;
    return this.remoteFacade.activeRemotes().flatMap(r => r.status.serve?.serves ?? []);
  });

  readonly allServes = computed(() => {
    const all = this.rawServes();
    const filter = this.selectedOriginFilter();
    if (filter === 'all') return all;

    const quickRunNames = new Set(
      this.quickRunService
        .quickRuns()
        .filter(qr => qr.operationType === 'serve')
        .map(qr => qr.name)
    );

    if (filter === 'quickrun' || filter === 'flow') {
      return all.filter(s => !!s.profile && quickRunNames.has(s.profile));
    }
    if (filter === 'dashboard') {
      return all.filter(s => !s.profile || !quickRunNames.has(s.profile));
    }
    return all;
  });

  onServeClick(serve: ServeListItem): void {
    this.serveClick.emit(serve);
  }

  onStopServe(serve: ServeListItem): void {
    this.stopServe.emit(serve);
  }
}
