import { ChangeDetectionStrategy, Component, model } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { Origin, ORIGIN_META } from '@app/types';

import { PillDirective } from '../../directives/pill.directive';
@Component({
  selector: 'app-origin-filter-bar',
  standalone: true,
  imports: [MatIconModule, TranslatePipe, PillDirective],
  templateUrl: './origin-filter-bar.component.html',
  styleUrls: ['./origin-filter-bar.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OriginFilterBarComponent {
  readonly selected = model<string>('all');

  /** "Dashboard" covers all work of a remote's own profiles, whichever way it was started. */
  protected readonly chips = (
    ['workflow', 'quickrun', 'dashboard'] as const satisfies readonly Origin[]
  ).map(origin => ({ origin, ...ORIGIN_META[origin] }));
}
