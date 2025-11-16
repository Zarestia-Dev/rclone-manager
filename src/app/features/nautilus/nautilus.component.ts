import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatButtonModule } from '@angular/material/button';
import { MatGridListModule } from '@angular/material/grid-list';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { AnimationsService } from '../../shared/services/animations.service';

@Component({
  selector: 'app-nautilus',
  standalone: true,
  imports: [
    CommonModule,
    MatListModule,
    MatIconModule,
    MatToolbarModule,
    MatSidenavModule,
    MatButtonModule,
    MatGridListModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatMenuModule,
  ],
  templateUrl: './nautilus.component.html',
  styleUrl: './nautilus.component.scss',
  animations: [AnimationsService.slideOverlay()],
})
export class NautilusComponent {
  @Input() isOverlay = false;

  @Input() showBackButton = false;

  @Output() closeOverlay = new EventEmitter<void>();

  onClose(): void {
    this.closeOverlay.emit();
  }

  // A back button for standalone web mode
  goBack(): void {
    this.closeOverlay.emit();
  }

  // TrackBy helpers
  trackByIndex(index: number): number {
    return index;
  }
}
