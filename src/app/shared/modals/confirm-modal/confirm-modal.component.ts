import { Component, HostListener, inject, ChangeDetectionStrategy } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { ConfirmDialogData } from '@app/types';

import { TranslatePipe } from '@ngx-translate/core';

@Component({
  selector: 'app-confirm-modal',
  imports: [MatButtonModule, MatIconModule, TranslatePipe],
  templateUrl: './confirm-modal.component.html',
  styleUrl: './confirm-modal.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmModalComponent {
  public readonly dialogRef = inject(MatDialogRef<ConfirmModalComponent>);
  public readonly data = inject<ConfirmDialogData>(MAT_DIALOG_DATA);

  @HostListener('document:keydown.escape', ['$event'])
  onEscapeKey(event: Event): void {
    const keyboardEvent = event as KeyboardEvent;
    keyboardEvent.preventDefault();
    this.onCancel();
  }

  @HostListener('document:keydown.enter', ['$event'])
  onEnterKey(event: Event): void {
    const keyboardEvent = event as KeyboardEvent;
    keyboardEvent.preventDefault();
    if (this.data.confirmText) {
      this.onConfirm();
    }
  }

  onConfirm(): void {
    this.dialogRef.close(true); // Return true when confirmed
  }

  onCancel(): void {
    this.dialogRef.close(false); // Return false when canceled
  }

  // Get the appropriate icon for the modal based on action type
  getModalIcon(): string {
    return this.data.icon || 'circle-info';
  }

  // Get the appropriate color for the modal icon
  getModalColor(): string {
    return this.data.color || 'primary';
  }
}
