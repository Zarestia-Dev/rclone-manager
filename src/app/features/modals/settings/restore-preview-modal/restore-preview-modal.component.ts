import { Component, inject, signal, ChangeDetectionStrategy, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatRadioModule } from '@angular/material/radio';
import { MatSelectModule } from '@angular/material/select';
import { DatePipe, UpperCasePipe } from '@angular/common';
import { BackupAnalysis, BackupRestoreService, ModalService } from '@app/services';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

const MIN_PASSWORD_LENGTH = 4;

@Component({
  selector: 'app-restore-preview-modal',
  standalone: true,
  imports: [
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatRadioModule,
    MatSelectModule,
    FormsModule,
    DatePipe,
    UpperCasePipe,
    TranslateModule,
  ],
  templateUrl: './restore-preview-modal.component.html',
  styleUrls: ['./restore-preview-modal.component.scss', '../../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RestorePreviewModalComponent {
  private readonly dialogRef = inject(MatDialogRef<RestorePreviewModalComponent>);
  private readonly backupRestoreService = inject(BackupRestoreService);
  private readonly translate = inject(TranslateService);
  private readonly modalService = inject(ModalService);
  private readonly data = inject<{ backupPath: string; analysis: BackupAnalysis }>(MAT_DIALOG_DATA);

  readonly analysis: BackupAnalysis = this.data.analysis;
  readonly backupPath: string = this.data.backupPath;

  // Static derived data — plain properties since `analysis` is not a signal
  readonly isEncrypted = this.analysis.isEncrypted;
  readonly isLegacy = this.analysis.isLegacy === true;
  readonly hasContents = !!this.analysis.contents;
  readonly hasUserNote = !!this.analysis.userNote;
  readonly profiles = this.analysis.contents?.profiles ?? [];
  readonly showRemoteCount = (this.analysis.contents?.remoteCount ?? 0) > 1;
  readonly itemCount = this.#computeItemCount();

  // Mutable UI state
  readonly password = signal('');
  readonly isVerifying = signal(false);
  readonly passwordError = signal<string | null>(null);
  readonly showPassword = signal(false);
  readonly selectedProfile = signal<string | null>(null);
  readonly restoreScope = signal<'all' | 'profile'>('all');

  toggleRestoreScope(scope: 'all' | 'profile'): void {
    this.restoreScope.set(scope);
    if (scope === 'all') {
      this.selectedProfile.set(null);
    } else if (this.profiles.length > 0 && !this.selectedProfile()) {
      this.selectedProfile.set(this.profiles[0]);
    }
  }

  togglePasswordVisibility(): void {
    this.showPassword.update(show => !show);
  }

  onPasswordChange(value: string): void {
    this.password.set(value);
    this.passwordError.set(null);
  }

  async verifyAndRestore(): Promise<void> {
    if (this.isEncrypted) {
      const raw = this.password();
      const trimmed = raw?.trim();

      if (!trimmed) {
        const key = raw
          ? 'backup.restore.errors.passwordEmpty'
          : 'backup.restore.errors.passwordRequired';
        this.passwordError.set(this.translate.instant(key));
        return;
      }

      if (trimmed.length < MIN_PASSWORD_LENGTH) {
        this.passwordError.set(this.translate.instant('backup.restore.errors.passwordLength'));
        return;
      }
    }

    this.isVerifying.set(true);
    this.passwordError.set(null);

    const password = this.isEncrypted ? this.password().trim() : null;
    const restoreProfile =
      this.restoreScope() === 'profile' ? (this.selectedProfile() ?? undefined) : undefined;

    try {
      await this.backupRestoreService.restoreSettings(this.backupPath, password, restoreProfile);
      this.modalService.animatedClose(this.dialogRef, true);
    } catch (error) {
      this.#handleRestoreError(error);
    } finally {
      this.isVerifying.set(false);
    }
  }

  @HostListener('document:keydown.escape')
  close(): void {
    if (!this.isVerifying()) {
      this.modalService.animatedClose(this.dialogRef, false);
    }
  }

  #computeItemCount(): number {
    // native JavaScript private class field. I wonder that so lets give a try. So its cant accesible on runtime to...
    const c = this.analysis.contents;
    if (!c) return 0;
    return (
      (c.settings ? 1 : 0) +
      (c.backendConfig ? 1 : 0) +
      (c.rcloneConfig ? 1 : 0) +
      (c.remoteCount ?? 0)
    );
  }

  #handleRestoreError(error: unknown): void {
    const msg = String(error).toLowerCase();
    let key: string;

    if (msg.includes('wrong password')) key = 'backup.restore.errors.wrongPassword';
    else if (msg.includes('integrity check failed')) key = 'backup.restore.errors.integrityFailed';
    else if (msg.includes('checksum') || msg.includes('hash'))
      key = 'backup.restore.errors.verificationFailed';
    else if (msg.includes('password') && msg.includes('required'))
      key = 'backup.restore.errors.requiresPassword';
    else if (msg.includes('decrypt') || msg.includes('encryption'))
      key = 'backup.restore.errors.decryptFailed';
    else key = 'backup.restore.errors.generic';

    this.passwordError.set(
      this.translate.instant(key, key.endsWith('generic') ? { error: String(error) } : {})
    );
  }
}
