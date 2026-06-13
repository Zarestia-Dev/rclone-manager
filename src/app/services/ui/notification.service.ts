import { inject, Injectable } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslateService } from '@ngx-translate/core';
import { MatDialog, MatDialogConfig, MatDialogRef } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { ConfirmModalComponent } from '../../shared/modals/confirm-modal/confirm-modal.component';
import {
  InputModalComponent,
  InputModalData,
} from '../../shared/modals/input-modal/input-modal.component';
import { ConfirmDialogData } from '@app/types';

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
  private translate = inject(TranslateService);
  private dialog = inject(MatDialog);

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
  showError(message: string, action?: string, duration?: number): void {
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
  showWarning(message: string, action?: string, duration?: number): void {
    this.snackBar.open(message, action ?? this.translate.instant('common.ok'), {
      duration,
      panelClass: ['warning-snackbar'],
    });
  }

  async confirmModal(
    title: string,
    message: string,
    confirmText?: string,
    cancelText?: string,
    options?: Pick<ConfirmDialogData, 'icon' | 'color'>
  ): Promise<boolean> {
    const dialogData: ConfirmDialogData = {
      title,
      message,
      cancelText: cancelText ?? (confirmText ? 'common.no' : 'common.ok'),
      confirmText,
      ...options,
    };

    const dialogRef = this.openConfirm(dialogData);
    const result = await firstValueFrom(dialogRef.afterClosed());
    return !!result;
  }

  openConfirm(
    data: ConfirmDialogData,
    config: Partial<MatDialogConfig<ConfirmDialogData>> = {}
  ): MatDialogRef<ConfirmModalComponent, boolean> {
    return this.dialog.open(ConfirmModalComponent, {
      maxWidth: '480px',
      disableClose: true,
      data,
      ...config,
    });
  }

  openInput<T = any>(
    data: InputModalData,
    config: Partial<MatDialogConfig<InputModalData>> = {}
  ): MatDialogRef<InputModalComponent, T> {
    return this.dialog.open(InputModalComponent, {
      minWidth: '362px',
      disableClose: true,
      data,
      ...config,
    });
  }
}
