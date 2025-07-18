import { inject, Injectable } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDialog } from '@angular/material/dialog';
import { ConfirmModalComponent } from '../modals/confirm-modal/confirm-modal.component';
import { ConfirmDialogData } from '../components/types';

/**
 * Service for handling user notifications and confirmations
 * Centralizes snackbar, modal, and toast notifications
 */
@Injectable({
  providedIn: 'root',
})
export class NotificationService {
  private snackBar = inject(MatSnackBar);
  private dialog = inject(MatDialog);

  /**
   * Show success message
   */
  showSuccess(message: string, action = 'OK', duration = 3000): void {
    this.snackBar.open(message, action, {
      duration,
      panelClass: ['success-snackbar'],
    });
  }

  /**
   * Show error message
   */
  showError(message: string, action = 'Close', duration = 5000): void {
    this.snackBar.open(message, action, {
      duration,
      panelClass: ['error-snackbar'],
    });
  }

  /**
   * Show info message
   */
  showInfo(message: string, action = 'OK', duration = 3000): void {
    this.snackBar.open(message, action, {
      duration,
      panelClass: ['info-snackbar'],
    });
  }

  /**
   * Show warning message
   */
  showWarning(message: string, action = 'OK', duration = 4000): void {
    this.snackBar.open(message, action, {
      duration,
      panelClass: ['warning-snackbar'],
    });
  }

  /**
   * Show a generic snackbar (for backward compatibility)
   */
  openSnackBar(message: string, action: string, duration = 2000): void {
    this.snackBar.open(message, action, { duration });
  }

  /**
   * Show confirmation modal
   */
  confirmModal(
    title: string,
    message: string,
    confirmText = 'Yes',
    cancelText = 'No'
  ): Promise<boolean> {
    const dialogData: ConfirmDialogData = {
      title,
      message,
      cancelText,
      confirmText,
    };

    return new Promise(resolve => {
      const dialogRef = this.dialog.open(ConfirmModalComponent, {
        maxWidth: '480px',
        data: dialogData,
        disableClose: true,
      });

      dialogRef.afterClosed().subscribe(result => {
        resolve(!!result);
      });
    });
  }

  /**
   * Show alert modal
   */
  alertModal(title: string, message: string, buttonText = 'OK'): Promise<void> {
    const dialogData: ConfirmDialogData = {
      title,
      message,
      cancelText: buttonText,
    };

    return new Promise(resolve => {
      const dialogRef = this.dialog.open(ConfirmModalComponent, {
        maxWidth: '480px',
        data: dialogData,
        disableClose: true,
      });

      dialogRef.afterClosed().subscribe(() => {
        resolve();
      });
    });
  }
}
