import { Component, inject, OnInit, signal } from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatExpansionModule } from '@angular/material/expansion';
import { RclonePasswordService } from 'src/app/services/security/rclone-password.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

@Component({
  selector: 'app-backend-security',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    MatSnackBarModule,
    MatSlideToggleModule,
    MatExpansionModule,
    TranslateModule,
  ],
  templateUrl: './backend-security.component.html',
  styleUrls: ['./backend-security.component.scss'],
})
export class BackendSecurityComponent implements OnInit {
  private readonly passwordService = inject(RclonePasswordService);
  private readonly fb = inject(FormBuilder);
  private readonly snackBar = inject(MatSnackBar);
  private readonly translate = inject(TranslateService);

  // Security UI state
  readonly showSecurityPassword = signal(false);
  readonly showNewSecurityPassword = signal(false);

  // Keychain specific state
  readonly showKeychainInput = signal(false);

  // Encryption state
  readonly isConfigEncrypted = signal<boolean | null>(null);
  readonly hasStoredPassword = signal(false);
  readonly encryptionLoading = signal(false);

  // Security Form (Inline)
  securityForm: FormGroup = this.fb.group({
    currentPassword: [''],
    newPassword: [''],
    confirmPassword: [''],
    keychainPassword: [''],
  });

  async ngOnInit(): Promise<void> {
    await this.loadEncryptionStatus();
  }

  private async loadEncryptionStatus(): Promise<void> {
    try {
      const [hasPassword, isEncrypted] = await Promise.all([
        this.passwordService.hasStoredPassword(),
        this.passwordService.isConfigEncrypted(),
      ]);
      this.hasStoredPassword.set(hasPassword);
      this.isConfigEncrypted.set(isEncrypted);
    } catch (error) {
      console.error('Failed to load encryption status:', error);
    }
  }

  toggleSecurityPasswordVisibility(): void {
    this.showSecurityPassword.update(v => !v);
  }

  toggleNewSecurityPasswordVisibility(): void {
    this.showNewSecurityPassword.update(v => !v);
  }

  // Panel Management
  onPanelOpened(): void {
    this.securityForm.reset();
    this.showSecurityPassword.set(false);
    this.showNewSecurityPassword.set(false);
  }

  // Keychain Toggle Logic
  async onKeychainToggle(event: { checked: boolean }): Promise<void> {
    const isChecked = event.checked;

    if (!isChecked) {
      await this.removeStoredPassword();
    } else {
      this.showKeychainInput.set(true);
    }
  }

  async submitKeychainStore(): Promise<void> {
    const password = this.securityForm.get('keychainPassword')?.value;
    if (!password) return;

    this.encryptionLoading.set(true);
    try {
      await this.passwordService.validatePassword(password);
      await this.passwordService.storePassword(password);
      this.showSuccess('modals.backend.security.passwordStored');
      this.showKeychainInput.set(false);
      this.securityForm.patchValue({ keychainPassword: '' });
      await this.loadEncryptionStatus();
    } catch (error: unknown) {
      this.showError(error);
    } finally {
      this.encryptionLoading.set(false);
    }
  }

  cancelKeychainStore(): void {
    this.showKeychainInput.set(false);
    this.securityForm.patchValue({ keychainPassword: '' });
    this.loadEncryptionStatus();
  }

  // Action Submits
  async submitEncrypt(): Promise<void> {
    const { newPassword, confirmPassword } = this.securityForm.value;
    if (!newPassword) return;
    if (!this.validatePasswordsMatch(newPassword, confirmPassword)) return;

    this.encryptionLoading.set(true);
    try {
      await this.passwordService.encryptConfig(newPassword);
      await this.passwordService.storePassword(newPassword);
      await this.loadEncryptionStatus();
      this.showSuccess('modals.backend.security.encrypted');
      this.securityForm.reset();
    } catch (error: unknown) {
      this.showTranslatedError('modals.backend.security.encryptionFailed', error);
    } finally {
      this.encryptionLoading.set(false);
    }
  }

  async submitDecrypt(): Promise<void> {
    const { currentPassword } = this.securityForm.value;
    if (!currentPassword) return;

    this.encryptionLoading.set(true);
    try {
      await this.passwordService.unencryptConfig(currentPassword);
      await this.passwordService.removeStoredPassword();
      await this.loadEncryptionStatus();
      this.showSuccess('modals.backend.security.removeEncryption');
      this.securityForm.reset();
    } catch (error: unknown) {
      this.showTranslatedError('modals.backend.security.decryptionFailed', error);
    } finally {
      this.encryptionLoading.set(false);
    }
  }

  async submitChangePassword(): Promise<void> {
    const { currentPassword, newPassword, confirmPassword } = this.securityForm.value;
    if (!currentPassword || !newPassword) return;
    if (!this.validatePasswordsMatch(newPassword, confirmPassword)) return;

    this.encryptionLoading.set(true);
    try {
      await this.passwordService.changeConfigPassword(currentPassword, newPassword);
      await this.passwordService.storePassword(newPassword);
      await this.loadEncryptionStatus();
      this.showSuccess('modals.backend.security.passwordChanged');
      this.securityForm.reset();
    } catch (error: unknown) {
      this.showTranslatedError('modals.backend.security.passwordChangeFailed', error);
    } finally {
      this.encryptionLoading.set(false);
    }
  }

  async removeStoredPassword(): Promise<void> {
    try {
      this.encryptionLoading.set(true);
      await this.passwordService.removeStoredPassword();
      await this.loadEncryptionStatus();
      this.showSuccess('modals.backend.security.passwordRemoved');
    } catch (error: unknown) {
      this.showError(error);
      this.loadEncryptionStatus();
    } finally {
      this.encryptionLoading.set(false);
    }
  }

  // ============= Helper Methods =============

  /** Validate passwords match and show error if not */
  private validatePasswordsMatch(newPassword: string, confirmPassword: string): boolean {
    if (newPassword !== confirmPassword) {
      this.snackBar.open(
        this.translate.instant('modals.backend.security.passwordsMismatch'),
        this.translate.instant('common.close'),
        { duration: 3000, panelClass: 'snackbar-error' }
      );
      return false;
    }
    return true;
  }

  /** Show success snackbar with translated message */
  private showSuccess(key: string): void {
    this.snackBar.open(this.translate.instant(key), this.translate.instant('common.close'), {
      duration: 4000,
    });
  }

  /** Show generic error snackbar */
  private showError(error: unknown): void {
    const message = this.getErrorMessage(error);
    this.snackBar.open(
      `${this.translate.instant('common.error')}: ${message}`,
      this.translate.instant('common.close'),
      { duration: 6000, panelClass: 'snackbar-error' }
    );
  }

  /** Show translated error snackbar with message parameter */
  private showTranslatedError(key: string, error: unknown): void {
    this.snackBar.open(
      this.translate.instant(key, { message: this.getErrorMessage(error) }),
      this.translate.instant('common.close'),
      { duration: 6000, panelClass: 'snackbar-error' }
    );
  }

  /** Extract message from unknown error type */
  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
