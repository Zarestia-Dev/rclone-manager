import { Component, HostListener, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { ConfirmDialogData } from '@app/types';

import { TranslateModule } from '@ngx-translate/core';

@Component({
  selector: 'app-confirm-modal',
  standalone: true,
  imports: [MatDialogModule, MatButtonModule, MatIconModule, TranslateModule],
  templateUrl: './confirm-modal.component.html',
  styleUrl: './confirm-modal.component.scss',
})
export class ConfirmModalComponent {
  public dialogRef = inject(MatDialogRef<ConfirmModalComponent>);
  public data = inject<ConfirmDialogData>(MAT_DIALOG_DATA);

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
  getModalIconColor(): string {
    return this.data.iconColor || 'primary';
  }

  // Get the appropriate color for the confirm button
  getConfirmButtonColor(): string {
    return this.data.confirmButtonColor || 'primary';
  }

  // Get the appropriate CSS class for the modal icon
  getModalIconClass(): string {
    return this.data.iconClass || 'info';
  }
}
