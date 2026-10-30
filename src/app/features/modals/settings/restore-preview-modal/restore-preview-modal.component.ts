import { Component, inject, signal, ChangeDetectionStrategy, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatRadioModule } from '@angular/material/radio';
import { MatSelectModule } from '@angular/material/select';
import { DatePipe, UpperCasePipe } from '@angular/common';
import { BackupRestoreService } from 'src/app/services/settings/backup-restore.service';
import { BackupAnalysis } from '@app/types';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { BackendTranslationService } from 'src/app/services/i18n/backend-translation.service';
import { AlertBannerComponent } from 'src/app/shared/components/alert-banner/alert-banner.component';

@Component({
  selector: 'app-restore-preview-modal',
  imports: [
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatRadioModule,
    MatSelectModule,
    FormsModule,
    DatePipe,
    UpperCasePipe,
    TranslatePipe,
    AlertBannerComponent,
  ],
  templateUrl: './restore-preview-modal.component.html',
  styleUrls: ['./restore-preview-modal.component.scss', '../../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RestorePreviewModalComponent {
  private readonly dialogRef = inject(MatDialogRef<RestorePreviewModalComponent>);
  private readonly backupRestoreService = inject(BackupRestoreService);
  private readonly translate = inject(TranslateService);
  private readonly backendTranslation = inject(BackendTranslationService);
  private readonly data = inject<{ backupPath: string; analysis: BackupAnalysis }>(MAT_DIALOG_DATA);

  readonly analysis: BackupAnalysis = this.data.analysis;
  readonly backupPath: string = this.data.backupPath;

  // Static derived data — plain properties since `analysis` is not a signal
  readonly isEncrypted = this.analysis.isEncrypted;
  readonly hasContents = !!this.analysis.contents;
  readonly hasUserNote = !!this.analysis.userNote;
  readonly profiles = this.analysis.contents?.profiles ?? [];
  readonly showRemoteCount = (this.analysis.contents?.remoteCount ?? 0) > 1;
  // App-side remote settings without any rclone definitions restore as orphans.
  readonly missingRemoteDefinitions =
    (this.analysis.contents?.remoteCount ?? 0) > 0 && !this.analysis.contents?.remoteDefinitions;
  readonly itemCount = this.computeItemCount();

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
    }

    this.isVerifying.set(true);
    this.passwordError.set(null);

    const password = this.isEncrypted ? this.password().trim() : null;
    const restoreProfile =
      this.restoreScope() === 'profile' ? (this.selectedProfile() ?? undefined) : undefined;

    try {
      await this.backupRestoreService.restoreSettings(this.backupPath, password, restoreProfile);
      this.dialogRef.close(true);
    } catch (error) {
      this.passwordError.set(this.backendTranslation.translateBackendMessage(error));
    } finally {
      this.isVerifying.set(false);
    }
  }

  @HostListener('document:keydown.escape')
  close(): void {
    if (!this.isVerifying()) {
      this.dialogRef.close(false);
    }
  }

  private computeItemCount(): number {
    const c = this.analysis.contents;
    if (!c) return 0;
    return (
      (c.settings ? 1 : 0) +
      (c.backendConfig ? 1 : 0) +
      (c.rcloneConfig ? 1 : 0) +
      (c.remoteCount ?? 0)
    );
  }
}
