import {
  Component,
  inject,
  signal,
  ChangeDetectionStrategy,
  computed,
  HostListener,
} from '@angular/core';
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
import { BackupAnalysis, BackupRestoreService } from '@app/services';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

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
  // Injected Services
  private readonly dialogRef = inject(MatDialogRef<RestorePreviewModalComponent>);
  private readonly backupRestoreService = inject(BackupRestoreService);
  private readonly translate = inject(TranslateService);
  public readonly data = inject<{ backupPath: string; analysis: BackupAnalysis }>(MAT_DIALOG_DATA);

  // Signals
  readonly password = signal('');
  readonly isVerifying = signal(false);
  readonly passwordError = signal<string | null>(null);
  readonly showPassword = signal(false);
  readonly selectedProfile = signal<string | null>(null);
  readonly restoreScope = signal<'all' | 'profile'>('all');

  // Data from injection
  readonly analysis: BackupAnalysis = this.data.analysis;
  readonly backupPath: string = this.data.backupPath;

  // Computed Signals
  readonly isEncrypted = computed(() => this.analysis.isEncrypted);
  readonly hasContents = computed(() => !!this.analysis.contents);
  readonly hasUserNote = computed(() => !!this.analysis.userNote);
  readonly profiles = computed(() => this.analysis.contents?.profiles || []);

  /**
   * Toggles restore scope
   */
  toggleRestoreScope(scope: 'all' | 'profile'): void {
    this.restoreScope.set(scope);
    if (scope === 'all') {
      this.selectedProfile.set(null);
    } else if (this.profiles().length > 0 && !this.selectedProfile()) {
      this.selectedProfile.set(this.profiles()[0]);
    }
  }

  /**
   * Gets the total count of items in the backup
   */
  getItemCount(): number {
    let count = 0;
    // console.log(this.analysis);

    if (!this.analysis.contents) return count;

    const contents = this.analysis.contents;
    if (contents.settings) count++;
    if (contents.backendConfig) count++;
    if (contents.rcloneConfig) count++;
    if (contents.remoteCount) count += contents.remoteCount;

    return count;
  }

  /**
   * Toggles password visibility
   */
  togglePasswordVisibility(): void {
    this.showPassword.update(show => !show);
  }

  /**
   * Handles password input changes
   */
  onPasswordChange(value: string): void {
    this.password.set(value);
    this.passwordError.set(null);
  }

  /**
   * Verifies password and initiates restore process
   */
  async verifyAndRestore(): Promise<void> {
    // Validate password for encrypted backups
    if (this.isEncrypted()) {
      const rawPassword = this.password();
      if (!rawPassword) {
        this.passwordError.set(this.translate.instant('backup.restore.errors.passwordRequired'));
        return;
      }

      const trimmedPassword = rawPassword.trim();
      if (!trimmedPassword) {
        this.passwordError.set(this.translate.instant('backup.restore.errors.passwordEmpty'));
        return;
      }

      // Check minimum password length (should match backend validation)
      if (trimmedPassword.length < 4) {
        this.passwordError.set(this.translate.instant('backup.restore.errors.passwordLength'));
        return;
      }
    }

    this.isVerifying.set(true);
    this.passwordError.set(null);

    const password = this.isEncrypted() ? this.password().trim() : null;
    const restoreProfile = this.restoreScope() === 'profile' ? this.selectedProfile() ?? undefined : undefined;

    try {
      await this.backupRestoreService.restoreSettings(this.backupPath, password, restoreProfile);
      // Close modal with success
      this.dialogRef.close(true);
    } catch (error: any) {
      this.handleRestoreError(error);
    } finally {
      this.isVerifying.set(false);
    }
  }

  /**
   * Handles restore errors with appropriate user feedback
   */
  private handleRestoreError(error: any): void {
    const errorMsg = String(error).toLowerCase();

    // Check for specific error types
    if (errorMsg.includes('wrong password')) {
      this.passwordError.set(this.translate.instant('backup.restore.errors.wrongPassword'));
    } else if (errorMsg.includes('integrity check failed')) {
      this.passwordError.set(this.translate.instant('backup.restore.errors.integrityFailed'));
    } else if (errorMsg.includes('checksum') || errorMsg.includes('hash')) {
      this.passwordError.set(this.translate.instant('backup.restore.errors.verificationFailed'));
    } else if (errorMsg.includes('password') && errorMsg.includes('required')) {
      this.passwordError.set(this.translate.instant('backup.restore.errors.requiresPassword'));
    } else if (errorMsg.includes('decrypt') || errorMsg.includes('encryption')) {
      this.passwordError.set(this.translate.instant('backup.restore.errors.decryptFailed'));
    } else {
      // Generic error
      this.passwordError.set(
        this.translate.instant('backup.restore.errors.generic', { error: String(error) })
      );
    }
  }

  /**
   * Closes the modal without restoring
   */
  @HostListener('document:keydown.escape')
  close(): void {
    if (!this.isVerifying()) {
      this.dialogRef.close(false);
    }
  }
}
