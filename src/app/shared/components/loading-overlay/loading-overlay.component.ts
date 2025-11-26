import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { AnimationsService } from '../../services/animations.service';

@Component({
  selector: 'app-loading-overlay',
  standalone: true,
  imports: [CommonModule, MatIconModule],
  templateUrl: './loading-overlay.component.html',
  styleUrls: ['./loading-overlay.component.scss'],
  animations: [AnimationsService.fadeInOut(), AnimationsService.loadingSpinner()],
})
export class LoadingOverlayComponent {
  title = input('Loading');
  message = input('Please wait...');
  icon = input('rotate');
}
