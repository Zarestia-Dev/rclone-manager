import { Injectable } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDialog } from '@angular/material/dialog';
import { ConfirmModalComponent } from '../../modals/confirm-modal/confirm-modal.component';
import { ConfirmDialogData } from '../../shared/components/types';

/**
 * Service for handling user notifications and confirmations
 * Centralizes snackbar, modal, and toast notifications
 */
@Injectable({
  providedIn: 'root'
})
export class NotificationService {

  constructor(
    private snackBar: MatSnackBar,
    private dialog: MatDialog
  ) { }

  /**
   * Show success message
   */
  showSuccess(message: string, action: string = 'OK', duration: number = 3000): void {
    this.snackBar.open(message, action, {
      duration,
      panelClass: ['success-snackbar']
    });
  }

  /**
   * Show error message
   */
  showError(message: string, action: string = 'Close', duration: number = 5000): void {
    this.snackBar.open(message, action, {
      duration,
      panelClass: ['error-snackbar']
    });
  }

  /**
   * Show info message
   */
  showInfo(message: string, action: string = 'OK', duration: number = 3000): void {
    this.snackBar.open(message, action, {
      duration,
      panelClass: ['info-snackbar']
    });
  }

  /**
   * Show warning message
   */
  showWarning(message: string, action: string = 'OK', duration: number = 4000): void {
    this.snackBar.open(message, action, {
      duration,
      panelClass: ['warning-snackbar']
    });
  }

  /**
   * Show a generic snackbar (for backward compatibility)
   */
  openSnackBar(message: string, action: string, duration: number = 2000): void {
    this.snackBar.open(message, action, { duration });
  }

  /**
   * Show confirmation modal
   */
  confirmModal(
    title: string,
    message: string,
    confirmText: string = 'Yes',
    cancelText: string = 'No'
  ): Promise<boolean> {
    const dialogData: ConfirmDialogData = {
      title,
      message,
      cancelText,
      confirmText,
    };

    return new Promise((resolve) => {
      const dialogRef = this.dialog.open(ConfirmModalComponent, {
        maxWidth: '480px',
        data: dialogData,
        disableClose: true,
      });
      
      dialogRef.afterClosed().subscribe((result) => {
        resolve(!!result);
      });
    });
  }

  /**
   * Show alert modal
   */
  alertModal(title: string, message: string, buttonText: string = 'OK'): Promise<void> {
    const dialogData: ConfirmDialogData = {
      title,
      message,
      cancelText: buttonText,
    };

    return new Promise((resolve) => {
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
