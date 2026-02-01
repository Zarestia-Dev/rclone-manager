import { inject, Injectable } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDialog } from '@angular/material/dialog';
import { TranslateService } from '@ngx-translate/core';
import { ConfirmDialogData } from '@app/types';
import { ConfirmModalComponent } from 'src/app/shared/modals/confirm-modal/confirm-modal.component';

/**
 * Service for handling user notifications and confirmations
 * Centralizes snackbar, modal, and toast notifications
 * Automatically translates default button texts
 */
@Injectable({
  providedIn: 'root',
})
export class NotificationService {
  private snackBar = inject(MatSnackBar);
  private dialog = inject(MatDialog);
  private translate = inject(TranslateService);

  /**
   * Show success message
   * @param message Already translated message text
   * @param action Button text (defaults to translated 'OK')
   * @param duration Display duration in milliseconds
   */
  showSuccess(message: string, action?: string, duration = 3000): void {
    this.snackBar.open(message, action ?? this.translate.instant('common.ok'), {
      duration,
      panelClass: ['success-snackbar'],
    });
  }

  /**
   * Show error message
   * @param message Already translated message text
   * @param action Button text (defaults to translated 'Close')
   * @param duration Display duration in milliseconds
   */
  showError(message: string, action?: string, duration = 5000): void {
    this.snackBar.open(message, action ?? this.translate.instant('common.close'), {
      duration,
      panelClass: ['error-snackbar'],
    });
  }

  /**
   * Show info message
   * @param message Already translated message text
   * @param action Button text (defaults to translated 'OK')
   * @param duration Display duration in milliseconds
   */
  showInfo(message: string, action?: string, duration = 3000): void {
    this.snackBar.open(message, action ?? this.translate.instant('common.ok'), {
      duration,
      panelClass: ['info-snackbar'],
    });
  }

  /**
   * Show warning message
   * @param message Already translated message text
   * @param action Button text (defaults to translated 'OK')
   * @param duration Display duration in milliseconds
   */
  showWarning(message: string, action?: string, duration = 4000): void {
    this.snackBar.open(message, action ?? this.translate.instant('common.ok'), {
      duration,
      panelClass: ['warning-snackbar'],
    });
  }

  /**
   * Show a generic snackbar (for backward compatibility)
   * @param message Already translated message text
   * @param action Button text (should be pre-translated)
   * @param duration Display duration in milliseconds
   */
  openSnackBar(message: string, action: string, duration = 2000): void {
    this.snackBar.open(message, action, { duration });
  }

  /**
   * Show confirmation modal
   * @param title Modal title (should be pre-translated)
   * @param message Modal message (should be pre-translated)
   * @param confirmText Confirm button text (defaults to translated 'Yes')
   * @param cancelText Cancel button text (defaults to translated 'No')
   * @param options Optional icon and styling options
   */
  confirmModal(
    title: string,
    message: string,
    confirmText?: string,
    cancelText?: string,
    options?: Pick<ConfirmDialogData, 'icon' | 'iconColor' | 'iconClass' | 'confirmButtonColor'>
  ): Promise<boolean> {
    const dialogData: ConfirmDialogData = {
      title,
      message,
      cancelText: cancelText ?? this.translate.instant('common.no'),
      confirmText: confirmText ?? this.translate.instant('common.yes'),
      ...options,
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
   * @param title Modal title (should be pre-translated)
   * @param message Modal message (should be pre-translated)
   * @param buttonText Button text (defaults to translated 'OK')
   * @param options Optional icon and styling options
   */
  alertModal(
    title: string,
    message: string,
    buttonText?: string,
    options?: Pick<ConfirmDialogData, 'icon' | 'iconColor' | 'iconClass'>
  ): Promise<void> {
    const dialogData: ConfirmDialogData = {
      title,
      message,
      cancelText: buttonText ?? this.translate.instant('common.ok'),
      ...options,
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
