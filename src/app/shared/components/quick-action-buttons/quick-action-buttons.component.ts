import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, ChangeDetectionStrategy } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { QuickActionButton } from '@app/types';

@Component({
  selector: 'app-quick-action-buttons',
  standalone: true,
  imports: [
    CommonModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
  ],
  template: `
    <div class="quick-actions">
      @for (button of buttons; track button.id) {
        <button
          matMiniFab
          [matTooltip]="button.tooltip"
          [disabled]="button.isDisabled"
          [ngClass]="'action-btn ' + (button.cssClass || '')"
          (click)="onButtonClick(button.id, $event)"
        >
          @if (button.isLoading) {
            <mat-spinner diameter="20"></mat-spinner>
          } @else {
            <mat-icon [svgIcon]="button.icon"></mat-icon>
          }
        </button>
      }
    </div>
  `,
  styleUrls: ['./quick-action-buttons.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuickActionButtonsComponent {
  @Input() buttons: QuickActionButton[] = [];

  @Output() buttonClick = new EventEmitter<{ id: string; event: Event }>();

  onButtonClick(buttonId: string, event: Event): void {
    event.stopPropagation();
    this.buttonClick.emit({ id: buttonId, event });
  }
}
