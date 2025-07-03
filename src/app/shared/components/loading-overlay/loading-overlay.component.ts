import { Component, Input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { AnimationsService } from '../../../services/core/animations.service';

@Component({
  selector: 'app-loading-overlay',
  standalone: true,
  imports: [MatIconModule],
  templateUrl: './loading-overlay.component.html',
  styleUrls: ['./loading-overlay.component.scss'],
  animations: [
    AnimationsService.fadeInOut(),
    AnimationsService.loadingSpinner()
  ]
})
export class LoadingOverlayComponent {
  @Input() isVisible = false;
  @Input() title = 'Loading';
  @Input() message = 'Please wait...';
  @Input() icon = 'rotate';
  @Input() overlayType: 'fullscreen' | 'container' = 'fullscreen';
}
