import { ChangeDetectionStrategy, Component, model } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';

@Component({
  selector: 'app-origin-filter-bar',
  standalone: true,
  imports: [MatIconModule, TranslatePipe],
  templateUrl: './origin-filter-bar.component.html',
  styleUrls: ['./origin-filter-bar.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OriginFilterBarComponent {
  readonly selected = model<string>('all');
}
