import { Component, input, ChangeDetectionStrategy } from '@angular/core';

import { MatIconModule } from '@angular/material/icon';
import { TranslateModule } from '@ngx-translate/core';

@Component({
  selector: 'app-loading-overlay',
  standalone: true,
  imports: [MatIconModule, TranslateModule],
  templateUrl: './loading-overlay.component.html',
  styleUrls: ['./loading-overlay.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoadingOverlayComponent {
  title = input('shared.loadingOverlay.defaultTitle');
  message = input('shared.loadingOverlay.defaultMessage');
  icon = input('rotate');
}
