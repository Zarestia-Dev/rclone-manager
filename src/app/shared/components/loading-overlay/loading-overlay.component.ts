import { Component, input, ChangeDetectionStrategy } from '@angular/core';

import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';

@Component({
  selector: 'app-loading-overlay',
  imports: [MatIconModule, TranslatePipe],
  templateUrl: './loading-overlay.component.html',
  styleUrls: ['./loading-overlay.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoadingOverlayComponent {
  title = input('shared.loadingOverlay.defaultTitle');
  message = input('shared.loadingOverlay.defaultMessage');
  icon = input('rotate');
}
