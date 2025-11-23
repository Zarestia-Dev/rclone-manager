import { Component, HostListener, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { ConfirmDialogData } from '@app/types';

@Component({
  selector: 'app-confirm-modal',
  imports: [MatDialogModule, MatButtonModule, MatIconModule],
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
    // Only auto-confirm if it's not a destructive action
    if (!this.isDestructiveAction()) {
      this.onConfirm();
    }
  }

  onConfirm(): void {
    this.dialogRef.close(true); // Return true when confirmed
  }

  onCancel(): void {
    this.dialogRef.close(false); // Return false when canceled
  }

  // Determine if this is a destructive action based on title or button text
  isDestructiveAction(): boolean {
    const destructiveKeywords = [
      'delete',
      'remove',
      'destroy',
      'kill',
      'terminate',
      'clear',
      'reset',
      'wipe',
    ];
    const titleLower = this.data.title.toLowerCase();
    const confirmTextLower = (this.data.confirmText || '').toLowerCase();

    return destructiveKeywords.some(
      keyword => titleLower.includes(keyword) || confirmTextLower.includes(keyword)
    );
  }

  // Get the appropriate icon for the modal based on action type
  getModalIcon(): string {
    if (this.isDestructiveAction()) {
      // Check for specific destructive actions
      const titleLower = this.data.title.toLowerCase();
      if (titleLower.includes('delete')) return 'trash';
      if (titleLower.includes('kill') || titleLower.includes('terminate'))
        return 'circle-exclamation';
      if (titleLower.includes('clear') || titleLower.includes('reset')) return 'rotate-left';
      return 'warning';
    } else {
      // Non-destructive actions
      const titleLower = this.data.title.toLowerCase();
      if (titleLower.includes('save')) return 'circle-check';
      if (titleLower.includes('confirm')) return 'circle-check';
      if (titleLower.includes('continue')) return 'chevron-right';
      return 'circle-info';
    }
  }

  // Get the appropriate color for the modal icon
  getModalIconColor(): string {
    return this.isDestructiveAction() ? 'warn' : 'primary';
  }

  // Get the appropriate color for the confirm button
  getConfirmButtonColor(): string {
    return this.isDestructiveAction() ? 'warn' : 'primary';
  }

  // Get the appropriate CSS class for the modal icon
  getModalIconClass(): string {
    return this.isDestructiveAction() ? 'destructive' : 'info';
  }

  // Get the appropriate icon for the confirm button
  getConfirmIcon(): string {
    if (this.isDestructiveAction()) {
      const confirmTextLower = (this.data.confirmText || '').toLowerCase();
      if (confirmTextLower.includes('delete')) return 'trash';
      if (confirmTextLower.includes('kill')) return 'circle-exclamation';
      if (confirmTextLower.includes('remove')) return 'trash';
      return 'circle-exclamation';
    } else {
      const confirmTextLower = (this.data.confirmText || '').toLowerCase();
      if (confirmTextLower.includes('save')) return 'circle-check';
      if (confirmTextLower.includes('continue')) return 'chevron-right';
      if (confirmTextLower.includes('ok')) return 'circle-check';
      return 'circle-check';
    }
  }
}
