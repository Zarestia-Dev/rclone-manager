import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { MatTabsModule } from '@angular/material/tabs';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import {
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  Validators,
  AbstractControl,
  ValidationErrors,
} from '@angular/forms';
import { MatSnackBar } from '@angular/material/snack-bar';
import { openUrl } from '@tauri-apps/plugin-opener';

// Services
import { RclonePasswordService } from '@app/services';

@Component({
  selector: 'app-security-settings',
  standalone: true,
  imports: [
    CommonModule,
    MatTabsModule,
    MatIconModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    ReactiveFormsModule,
  ],
  templateUrl: './security-settings.component.html',
  styleUrl: './security-settings.component.scss',
})
export class SecuritySettingsComponent implements OnInit {
  private passwordService = inject(RclonePasswordService);
  private fb = inject(FormBuilder);
  private snackBar = inject(MatSnackBar);

  // Security tab management
  selectedSecurityTab = 0;

  // Password management forms
  overviewForm: FormGroup;
  encryptionForm: FormGroup;
  changePasswordForm: FormGroup;

  // Status flags for password manager
  hasStoredPassword = false;
  hasEnvPassword = false;
  isConfigEncrypted: boolean | null = null;
  isPasswordLoading = false;

  // Loading states for password operations
  passwordLoading = {
    isValidating: false,
    isEncrypting: false,
    isUnencrypting: false,
    isChangingPassword: false,
    isStoringPassword: false,
    isRemovingPassword: false,
    isSettingEnv: false,
    isClearingEnv: false,
  };

  constructor() {
    this.overviewForm = this.createOverviewForm();
    this.encryptionForm = this.createEncryptionForm();
    this.changePasswordForm = this.createChangePasswordForm();
  }

  async ngOnInit(): Promise<void> {
    await this.loadCachedPasswordStatusQuickly();
    this.refreshPasswordStatus().catch(err => {
      console.error('Failed to load password status:', err);
      this.isPasswordLoading = false;
    });
  }

  private async loadCachedPasswordStatusQuickly(): Promise<void> {
    try {
      const cachedStatus = await this.passwordService.getCachedEncryptionStatus();
      if (cachedStatus !== null) {
        this.isConfigEncrypted = cachedStatus;
      }
    } catch (err) {
      console.debug('No cached status available:', err);
    }
  }

  // Password Manager Form Creation
  private createOverviewForm(): FormGroup {
    return this.fb.group({
      password: ['', [Validators.required, this.createPasswordValidator()]],
    });
  }

  private createEncryptionForm(): FormGroup {
    return this.fb.group(
      {
        password: ['', [Validators.required, this.createPasswordValidator()]],
        confirmPassword: ['', [Validators.required]],
      },
      { validators: this.passwordMatchValidator }
    );
  }

  private createChangePasswordForm(): FormGroup {
    return this.fb.group(
      {
        currentPassword: ['', [Validators.required, this.createPasswordValidator()]],
        newPassword: ['', [Validators.required, this.createPasswordValidator()]],
        confirmNewPassword: ['', [Validators.required]],
      },
      { validators: this.newPasswordMatchValidator }
    );
  }

  // Password validators
  private createPasswordValidator() {
    return (control: AbstractControl): ValidationErrors | null => {
      const value = control.value;
      if (!value) return null;

      if (value.length < 3) {
        return {
          minLength: {
            message: 'Password must be at least 3 characters',
            actualLength: value.length,
            requiredLength: 3,
          },
        };
      }

      if (/['"]/.test(value)) {
        return { invalidChars: { message: 'Password cannot contain quotes' } };
      }

      return null;
    };
  }

  private passwordMatchValidator = (group: AbstractControl): ValidationErrors | null => {
    const password = group.get('password')?.value;
    const confirmPassword = group.get('confirmPassword')?.value;

    if (!password || !confirmPassword) return null;

    return password === confirmPassword
      ? null
      : { passwordMismatch: { message: 'Passwords do not match' } };
  };

  private newPasswordMatchValidator = (group: AbstractControl): ValidationErrors | null => {
    const newPassword = group.get('newPassword')?.value;
    const confirmNewPassword = group.get('confirmNewPassword')?.value;

    if (!newPassword || !confirmNewPassword) return null;

    return newPassword === confirmNewPassword
      ? null
      : { passwordMismatch: { message: 'Passwords do not match' } };
  };

  // Password Manager Methods
  get canValidatePassword(): boolean {
    return (
      (this.overviewForm.get('password')?.valid && this.overviewForm.get('password')?.enabled) ||
      false
    );
  }

  get canEncrypt(): boolean {
    return this.encryptionForm.valid && this.encryptionForm.enabled;
  }

  get canUnencrypt(): boolean {
    return (
      (this.encryptionForm.get('password')?.valid &&
        this.encryptionForm.get('password')?.enabled) ||
      false
    );
  }

  get canChangePassword(): boolean {
    return this.changePasswordForm.valid && this.changePasswordForm.enabled;
  }

  get canStorePassword(): boolean {
    return (
      (this.overviewForm.get('password')?.valid && this.overviewForm.get('password')?.enabled) ||
      false
    );
  }

  get isLoadingPassword(): boolean {
    return this.isPasswordLoading || this.isConfigEncrypted === null;
  }

  get isEncryptedConfig(): boolean {
    return this.isConfigEncrypted === true;
  }

  get isUnencryptedConfig(): boolean {
    return this.isConfigEncrypted === false;
  }

  switchToEncryptionTab(): void {
    this.selectedSecurityTab = 1;
  }

  learnMoreAboutEncryption(): void {
    openUrl('https://rclone.org/docs/#configuration-encryption').catch(err => {
      console.error('Failed to open URL:', err);
      this.showError('Failed to open documentation');
    });
  }

  async validatePassword(): Promise<void> {
    const passwordControl = this.overviewForm.get('password');
    if (!passwordControl?.valid || !passwordControl?.value) return;

    this.passwordLoading.isValidating = true;
    try {
      await this.passwordService.validatePassword(passwordControl.value);
      this.showSuccess('Password is valid!');
    } catch (error) {
      passwordControl.setErrors({ apiError: { message: 'Invalid password' } });
      this.showError(this.getErrorMessage(error));
    } finally {
      this.passwordLoading.isValidating = false;
    }
  }

  async storePassword(): Promise<void> {
    if (!this.canStorePassword) return;

    const passwordControl = this.overviewForm.get('password');
    if (!passwordControl?.value) return;

    this.passwordLoading.isStoringPassword = true;
    try {
      await this.passwordService.validatePassword(passwordControl.value);
      await this.passwordService.storePassword(passwordControl.value);
      this.resetPasswordForms();
      this.showSuccess('Password stored securely in system keychain');
      await this.refreshPasswordStatus();
    } catch (error) {
      this.showError(`Failed to store password: ${this.getErrorMessage(error)}`);
    } finally {
      this.passwordLoading.isStoringPassword = false;
    }
  }

  async removePassword(): Promise<void> {
    this.passwordLoading.isRemovingPassword = true;
    try {
      await this.passwordService.removeStoredPassword();
      this.showSuccess('Stored password removed from system keychain');
      await this.refreshPasswordStatus();
    } catch (err) {
      console.error('Remove password error:', err);
      this.showError('Failed to remove stored password');
    } finally {
      this.passwordLoading.isRemovingPassword = false;
    }
  }

  async encryptConfig(): Promise<void> {
    if (!this.canEncrypt) return;

    const passwordControl = this.encryptionForm.get('password');
    if (!passwordControl?.value) return;

    this.passwordLoading.isEncrypting = true;
    try {
      await this.passwordService.encryptConfig(passwordControl.value);
      await this.passwordService.clearEncryptionCache();
      this.showSuccess('Configuration encrypted successfully');
      this.resetPasswordForms();
      await this.refreshPasswordStatus();
    } catch (error) {
      this.showError(`Failed to encrypt configuration: ${this.getErrorMessage(error)}`);
    } finally {
      this.passwordLoading.isEncrypting = false;
    }
  }

  async unencryptConfig(): Promise<void> {
    if (!this.canUnencrypt) return;

    const passwordControl = this.encryptionForm.get('password');
    if (!passwordControl?.value) return;

    this.passwordLoading.isUnencrypting = true;
    try {
      await this.passwordService.unencryptConfig(passwordControl.value);
      await this.passwordService.clearEncryptionCache();
      this.showSuccess('Configuration unencrypted successfully');
      this.resetPasswordForms();
      await this.refreshPasswordStatus();
    } catch (error) {
      this.showError(`Failed to unencrypt configuration: ${this.getErrorMessage(error)}`);
    } finally {
      this.passwordLoading.isUnencrypting = false;
    }
  }

  async changePassword(): Promise<void> {
    if (!this.canChangePassword) return;

    const currentPasswordControl = this.changePasswordForm.get('currentPassword');
    const newPasswordControl = this.changePasswordForm.get('newPassword');

    if (!currentPasswordControl?.value || !newPasswordControl?.value) return;

    this.passwordLoading.isChangingPassword = true;
    try {
      await this.passwordService.changeConfigPassword(
        currentPasswordControl.value,
        newPasswordControl.value
      );
      await this.passwordService.clearEncryptionCache();
      this.showSuccess('Password changed successfully');
      this.resetPasswordForms();
      await this.refreshPasswordStatus();
    } catch (error) {
      this.showError(`Failed to change password: ${this.getErrorMessage(error)}`);
    } finally {
      this.passwordLoading.isChangingPassword = false;
    }
  }

  async setEnvPassword(): Promise<void> {
    this.passwordLoading.isSettingEnv = true;
    try {
      const storedPassword = await this.passwordService.getStoredPassword();
      if (storedPassword) {
        await this.passwordService.setConfigPasswordEnv(storedPassword);
        this.showSuccess('Environment variable set');
        await this.refreshPasswordStatus();
      } else {
        this.showError('No stored password found');
      }
    } catch (err) {
      console.error('Set env password error:', err);
      this.showError('Failed to set environment variable');
    } finally {
      this.passwordLoading.isSettingEnv = false;
    }
  }

  async clearEnvPassword(): Promise<void> {
    this.passwordLoading.isClearingEnv = true;
    try {
      await this.passwordService.clearPasswordEnvironment();
      this.showSuccess('Environment variable cleared');
      await this.refreshPasswordStatus();
    } catch (err) {
      console.error('Clear env password error:', err);
      this.showError('Failed to clear environment variable');
    } finally {
      this.passwordLoading.isClearingEnv = false;
    }
  }

  private async refreshPasswordStatus(): Promise<void> {
    try {
      const cachedStatus = await this.passwordService.getCachedEncryptionStatus();
      if (cachedStatus !== null && this.isPasswordLoading) {
        this.isConfigEncrypted = cachedStatus;
      }

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Status check timeout')), 5000);
      });

      const statusPromise = Promise.all([
        this.passwordService.hasStoredPassword(),
        this.passwordService.hasConfigPasswordEnv(),
        this.passwordService.isConfigEncryptedCached(),
      ]);

      const [hasStored, hasEnv, isEncrypted] = (await Promise.race([
        statusPromise,
        timeoutPromise,
      ])) as [boolean, boolean, boolean];

      this.hasStoredPassword = hasStored;
      this.hasEnvPassword = hasEnv;
      this.isConfigEncrypted = isEncrypted;
    } catch (error) {
      console.error('Failed to refresh password status:', error);
      if (this.isConfigEncrypted === null) {
        this.showError('Failed to load configuration status');
        this.isConfigEncrypted = false;
      }
      this.hasStoredPassword = false;
      this.hasEnvPassword = false;
    } finally {
      this.isPasswordLoading = false;
    }
  }

  private resetPasswordForms(): void {
    this.overviewForm.reset();
    this.encryptionForm.reset();
    this.changePasswordForm.reset();
  }

  private showSuccess(message: string): void {
    this.snackBar.open(`✅ ${message}`, 'Close', {
      duration: 3000,
      panelClass: ['success-snackbar'],
    });
  }

  private showError(message: string): void {
    this.snackBar.open(`❌ ${message}`, 'Close', {
      duration: 5000,
      panelClass: ['error-snackbar'],
    });
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
