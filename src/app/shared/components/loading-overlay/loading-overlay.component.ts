import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';

@Component({
  selector: 'app-loading-overlay',
  standalone: true,
  imports: [CommonModule, MatIconModule],
  templateUrl: './loading-overlay.component.html',
  styleUrls: ['./loading-overlay.component.scss'],
})
export class LoadingOverlayComponent {
  title = input('Loading');
  message = input('Please wait...');
  icon = input('rotate');
}
