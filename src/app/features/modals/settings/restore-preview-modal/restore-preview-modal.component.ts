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
import { DatePipe, UpperCasePipe } from '@angular/common';
import { BackupAnalysis, BackupRestoreService } from '@app/services';

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
    FormsModule,
    DatePipe,
    UpperCasePipe,
  ],
  templateUrl: './restore-preview-modal.component.html',
  styleUrls: ['./restore-preview-modal.component.scss', '../../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RestorePreviewModalComponent {
  // Injected Services
  private readonly dialogRef = inject(MatDialogRef<RestorePreviewModalComponent>);
  private readonly backupRestoreService = inject(BackupRestoreService);
  public readonly data = inject<{ backupPath: string; analysis: BackupAnalysis }>(MAT_DIALOG_DATA);

  // Signals
  readonly password = signal('');
  readonly isVerifying = signal(false);
  readonly passwordError = signal<string | null>(null);
  readonly showPassword = signal(false);

  // Data from injection
  readonly analysis: BackupAnalysis = this.data.analysis;
  readonly backupPath: string = this.data.backupPath;

  // Computed Signals
  readonly isEncrypted = computed(() => this.analysis.isEncrypted);
  readonly hasContents = computed(() => !!this.analysis.contents);
  readonly hasUserNote = computed(() => !!this.analysis.userNote);

  /**
   * Gets the total count of items in the backup
   */
  getItemCount(): number {
    let count = 0;
    console.log(this.analysis);

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
        this.passwordError.set('Password is required');
        return;
      }

      const trimmedPassword = rawPassword.trim();
      if (!trimmedPassword) {
        this.passwordError.set('Password cannot be empty or whitespace');
        return;
      }

      // Check minimum password length (should match backend validation)
      if (trimmedPassword.length < 4) {
        this.passwordError.set('Password must be at least 4 characters');
        return;
      }
    }

    this.isVerifying.set(true);
    this.passwordError.set(null);

    const password = this.isEncrypted() ? this.password().trim() : null;

    try {
      await this.backupRestoreService.restoreSettings(this.backupPath, password);
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
      this.passwordError.set('Incorrect password. Please try again.');
    } else if (errorMsg.includes('integrity check failed')) {
      this.passwordError.set('Backup file is corrupted or has been tampered with.');
    } else if (errorMsg.includes('checksum') || errorMsg.includes('hash')) {
      this.passwordError.set('File verification failed. The backup may be corrupted.');
    } else if (errorMsg.includes('password') && errorMsg.includes('required')) {
      this.passwordError.set('This backup requires a password to decrypt.');
    } else if (errorMsg.includes('decrypt') || errorMsg.includes('encryption')) {
      this.passwordError.set('Failed to decrypt backup. Check your password.');
    } else {
      // Generic error
      this.passwordError.set('An error occurred during restore: ' + String(error));
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
