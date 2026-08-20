import { inject, Injectable } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslateService } from '@ngx-translate/core';
import { MatDialog, MatDialogConfig, MatDialogRef } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import type { ConfirmModalComponent } from '../../shared/modals/confirm-modal/confirm-modal.component';
import type {
  InputModalData,
  InputModalComponent,
} from '../../shared/modals/input-modal/input-modal.component';
import { ConfirmDialogData } from '@app/types';
import { BackendTranslationService } from '../i18n/backend-translation.service';

type NotificationSeverity = 'success' | 'error' | 'info' | 'warning';

@Injectable({ providedIn: 'root' })
export class NotificationService {
  private snackBar = inject(MatSnackBar);
  private translate = inject(TranslateService);
  private dialog = inject(MatDialog);
  private backendTranslation = inject(BackendTranslationService);

  /** Default action label per severity. */
  private static readonly DEFAULT_ACTION_KEY = {
    success: 'common.ok',
    info: 'common.ok',
    warning: 'common.close',
    error: 'common.close',
  } as const;

  /** Default duration per severity (undefined = no auto-dismiss). */
  private static readonly DEFAULT_DURATION_MS: Record<NotificationSeverity, number | undefined> = {
    success: 3000,
    info: 3000,
    warning: 4000,
    error: undefined,
  };

  showSuccess(message: unknown, action?: string, duration?: number): void {
    this.show('success', message, action, duration);
  }

  showError(message: unknown, action?: string, duration?: number): void {
    this.show('error', message, action, duration);
  }

  showInfo(message: unknown, action?: string, duration?: number): void {
    this.show('info', message, action, duration);
  }

  showWarning(message: unknown, action?: string, duration?: number): void {
    this.show('warning', message, action, duration);
  }

  private show(
    severity: NotificationSeverity,
    message: unknown,
    action: string | undefined,
    duration: number | undefined
  ): void {
    const resolvedMessage = this.backendTranslation.translateBackendMessage(message);
    const resolvedAction =
      action ?? this.translate.instant(NotificationService.DEFAULT_ACTION_KEY[severity]);
    const resolvedDuration = duration ?? NotificationService.DEFAULT_DURATION_MS[severity];
    this.snackBar.open(resolvedMessage, resolvedAction, {
      duration: resolvedDuration,
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
  ): Promise<MatDialogRef<ConfirmModalComponent, boolean>> {
    const { ConfirmModalComponent } =
      await import('../../shared/modals/confirm-modal/confirm-modal.component');
    return this.dialog.open(ConfirmModalComponent, {
      maxWidth: '480px',
      disableClose: true,
      data,
      ...config,
      panelClass: 'mobile-sheet-dialog',
    });
  }

  async openInput<T = unknown>(
    data: InputModalData,
    config: Partial<MatDialogConfig<InputModalData>> = {}
  ): Promise<MatDialogRef<InputModalComponent, T>> {
    const { InputModalComponent } =
      await import('../../shared/modals/input-modal/input-modal.component');
    return this.dialog.open(InputModalComponent, {
      minWidth: '362px',
      disableClose: true,
      data,
      ...config,
      panelClass: 'mobile-sheet-dialog',
    });
  }
}
