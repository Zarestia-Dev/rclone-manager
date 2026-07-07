import { inject, Injectable } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslateService } from '@ngx-translate/core';
import { MatDialog, MatDialogConfig, MatDialogRef } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import type { InputModalData } from '../../shared/modals/input-modal/input-modal.component';
import { ConfirmDialogData } from '@app/types';

/**
 * Centralizes snackbar, modal, and toast notifications.
 * Button texts default to their translated `common.*` counterparts.
 */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private snackBar = inject(MatSnackBar);
  private translate = inject(TranslateService);
  private dialog = inject(MatDialog);

  showSuccess(message: string, action?: string, duration = 3000): void {
    this.snackBar.open(message, action ?? this.translate.instant('common.ok'), {
      duration,
    });
  }

  showError(message: string, action?: string, duration?: number): void {
    this.snackBar.open(message, action ?? this.translate.instant('common.close'), {
      duration,
    });
  }

  showInfo(message: string, action?: string, duration = 3000): void {
    this.snackBar.open(message, action ?? this.translate.instant('common.ok'), {
      duration,
    });
  }

  showWarning(message: string, action?: string, duration?: number): void {
    this.snackBar.open(message, action ?? this.translate.instant('common.ok'), {
      duration,
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

    const dialogRef = await this.openConfirm(dialogData);
    const result = await firstValueFrom(dialogRef.afterClosed());
    return !!result;
  }

  async openConfirm(
    data: ConfirmDialogData,
    config: Partial<MatDialogConfig<ConfirmDialogData>> = {}
  ): Promise<MatDialogRef<any, boolean>> {
    const { ConfirmModalComponent } =
      await import('../../shared/modals/confirm-modal/confirm-modal.component');
    return this.dialog.open(ConfirmModalComponent, {
      maxWidth: '480px',
      disableClose: true,
      data,
      ...config,
    });
  }

  async openInput<T = any>(
    data: InputModalData,
    config: Partial<MatDialogConfig<InputModalData>> = {}
  ): Promise<MatDialogRef<any, T>> {
    const { InputModalComponent } =
      await import('../../shared/modals/input-modal/input-modal.component');
    return this.dialog.open(InputModalComponent, {
      minWidth: '362px',
      disableClose: true,
      data,
      ...config,
    });
  }
}
