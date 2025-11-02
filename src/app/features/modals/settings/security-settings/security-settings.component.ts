import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, OnDestroy } from '@angular/core';
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
import { Subject } from 'rxjs';
import { RclonePasswordService } from '@app/services';

interface PasswordStatus {
  hasStored: boolean;
  hasEnv: boolean;
  isEncrypted: boolean;
}

interface LoadingStates {
  isValidating: boolean;
  isEncrypting: boolean;
  isUnencrypting: boolean;
  isChangingPassword: boolean;
  isStoringPassword: boolean;
  isRemovingPassword: boolean;
  isSettingEnv: boolean;
  isClearingEnv: boolean;
}

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
export class SecuritySettingsComponent implements OnInit, OnDestroy {
  private readonly passwordService = inject(RclonePasswordService);
  private readonly fb = inject(FormBuilder);
  private readonly snackBar = inject(MatSnackBar);
  private readonly destroy$ = new Subject<void>();

  // UI State
  selectedSecurityTab = 0;
  isPasswordLoading = false;

  // Password Status
  hasStoredPassword = false;
  hasEnvPassword = false;
  isConfigEncrypted: boolean | null = null;

  // Forms
  overviewForm: FormGroup;
  encryptionForm: FormGroup;
  changePasswordForm: FormGroup;

  // Loading States
  passwordLoading: LoadingStates = {
    isValidating: false,
    isEncrypting: false,
    isUnencrypting: false,
    isChangingPassword: false,
    isStoringPassword: false,
    isRemovingPassword: false,
    isSettingEnv: false,
    isClearingEnv: false,
  };

  // Computed Properties
  get canValidatePassword(): boolean {
    return this.isFormFieldValid(this.overviewForm, 'password');
  }

  get canEncrypt(): boolean {
    return this.encryptionForm.valid && this.encryptionForm.enabled;
  }

  get canUnencrypt(): boolean {
    return this.isFormFieldValid(this.encryptionForm, 'password');
  }

  get canChangePassword(): boolean {
    return this.changePasswordForm.valid && this.changePasswordForm.enabled;
  }

  get canStorePassword(): boolean {
    return this.isFormFieldValid(this.overviewForm, 'password');
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

  get isAnyOperationInProgress(): boolean {
    return Object.values(this.passwordLoading).some(state => state);
  }

  constructor() {
    this.overviewForm = this.createPasswordForm(['password']);
    this.encryptionForm = this.createPasswordForm(['password', 'confirmPassword'], true);
    this.changePasswordForm = this.createPasswordForm(
      ['currentPassword', 'newPassword', 'confirmNewPassword'],
      true
    );
  }

  async ngOnInit(): Promise<void> {
    await this.loadCachedPasswordStatus();
    this.refreshPasswordStatus().catch(err => {
      console.error('Failed to load password status:', err);
      this.isPasswordLoading = false;
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // Form Creation
  private createPasswordForm(fields: string[], withConfirmation = false): FormGroup {
    const group: Record<string, unknown[]> = {};

    fields.forEach(field => {
      group[field] = ['', [Validators.required, this.passwordValidator()]];
    });

    const formGroup = this.fb.group(group);

    if (withConfirmation) {
      formGroup.setValidators(this.createPasswordMatchValidator(fields));
    }

    return formGroup;
  }

  private passwordValidator() {
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

  private createPasswordMatchValidator(fields: string[]) {
    return (group: AbstractControl): ValidationErrors | null => {
      if (fields.length === 2) {
        // For encryption form (password + confirmPassword)
        const password = group.get(fields[0])?.value;
        const confirm = group.get(fields[1])?.value;

        if (password && confirm && password !== confirm) {
          return { passwordMismatch: { message: 'Passwords do not match' } };
        }
      } else if (fields.length === 3) {
        // For change password form (currentPassword + newPassword + confirmNewPassword)
        const newPassword = group.get(fields[1])?.value;
        const confirmNew = group.get(fields[2])?.value;

        if (newPassword && confirmNew && newPassword !== confirmNew) {
          return { passwordMismatch: { message: 'Passwords do not match' } };
        }
      }

      return null;
    };
  }

  // UI Actions
  switchToEncryptionTab(): void {
    this.selectedSecurityTab = 1;
  }

  learnMoreAboutEncryption(): void {
    openUrl('https://rclone.org/docs/#configuration-encryption').catch(err => {
      console.error('Failed to open URL:', err);
      this.showError('Failed to open documentation');
    });
  }

  // Password Operations
  async validatePassword(): Promise<void> {
    await this.executePasswordOperation(
      'isValidating',
      async () => {
        const password = this.getFormValue(this.overviewForm, 'password');
        await this.passwordService.validatePassword(password);
        this.showSuccess('Password is valid!');
      },
      this.overviewForm.get('password')
    );
  }

  async storePassword(): Promise<void> {
    await this.executePasswordOperation('isStoringPassword', async () => {
      const password = this.getFormValue(this.overviewForm, 'password');
      await this.passwordService.validatePassword(password);
      await this.passwordService.storePassword(password);
      this.resetPasswordForms();
      this.showSuccess('Password stored securely in system keychain');
      await this.refreshPasswordStatus();
    });
  }

  async removePassword(): Promise<void> {
    await this.executePasswordOperation('isRemovingPassword', async () => {
      await this.passwordService.removeStoredPassword();
      this.showSuccess('Stored password removed from system keychain');
      await this.refreshPasswordStatus();
    });
  }

  async encryptConfig(): Promise<void> {
    await this.executePasswordOperation('isEncrypting', async () => {
      const password = this.getFormValue(this.encryptionForm, 'password');
      await this.passwordService.encryptConfig(password);
      await this.passwordService.clearEncryptionCache();
      this.showSuccess('Configuration encrypted successfully');
      this.resetPasswordForms();
      await this.refreshPasswordStatus();
    });
  }

  async unencryptConfig(): Promise<void> {
    await this.executePasswordOperation('isUnencrypting', async () => {
      const password = this.getFormValue(this.encryptionForm, 'password');
      await this.passwordService.unencryptConfig(password);
      await this.passwordService.clearEncryptionCache();
      this.showSuccess('Configuration unencrypted successfully');
      this.resetPasswordForms();
      await this.refreshPasswordStatus();
    });
  }

  async changePassword(): Promise<void> {
    await this.executePasswordOperation('isChangingPassword', async () => {
      const currentPassword = this.getFormValue(this.changePasswordForm, 'currentPassword');
      const newPassword = this.getFormValue(this.changePasswordForm, 'newPassword');

      await this.passwordService.changeConfigPassword(currentPassword, newPassword);
      await this.passwordService.clearEncryptionCache();
      this.showSuccess('Password changed successfully');
      this.resetPasswordForms();
      await this.refreshPasswordStatus();
    });
  }

  async setEnvPassword(): Promise<void> {
    await this.executePasswordOperation('isSettingEnv', async () => {
      const storedPassword = await this.passwordService.getStoredPassword();
      if (!storedPassword) {
        throw new Error('No stored password found');
      }
      await this.passwordService.setConfigPasswordEnv(storedPassword);
      this.showSuccess('Environment variable set');
      await this.refreshPasswordStatus();
    });
  }

  async clearEnvPassword(): Promise<void> {
    await this.executePasswordOperation('isClearingEnv', async () => {
      await this.passwordService.clearPasswordEnvironment();
      this.showSuccess('Environment variable cleared');
      await this.refreshPasswordStatus();
    });
  }

  // Helper Methods
  private async loadCachedPasswordStatus(): Promise<void> {
    try {
      const cachedStatus = await this.passwordService.getCachedEncryptionStatus();
      if (cachedStatus !== null) {
        this.isConfigEncrypted = cachedStatus;
      }
    } catch (err) {
      console.debug('No cached status available:', err);
    }
  }

  private async refreshPasswordStatus(): Promise<void> {
    try {
      // Show cached status immediately if loading
      if (this.isPasswordLoading) {
        const cachedStatus = await this.passwordService.getCachedEncryptionStatus();
        if (cachedStatus !== null) {
          this.isConfigEncrypted = cachedStatus;
        }
      }

      // Fetch fresh status with timeout
      const status = await this.fetchPasswordStatusWithTimeout();
      this.applyPasswordStatus(status);
    } catch (error) {
      this.handleStatusError(error);
    } finally {
      this.isPasswordLoading = false;
    }
  }

  private async fetchPasswordStatusWithTimeout(): Promise<PasswordStatus> {
    const timeoutPromise = new Promise<never>((_, reject) => {
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

    return { hasStored, hasEnv, isEncrypted };
  }

  private applyPasswordStatus(status: PasswordStatus): void {
    this.hasStoredPassword = status.hasStored;
    this.hasEnvPassword = status.hasEnv;
    this.isConfigEncrypted = status.isEncrypted;
  }

  private handleStatusError(error: unknown): void {
    console.error('Failed to refresh password status:', error);
    if (this.isConfigEncrypted === null) {
      this.showError('Failed to load configuration status');
      this.isConfigEncrypted = false;
    }
    this.hasStoredPassword = false;
    this.hasEnvPassword = false;
  }

  private async executePasswordOperation(
    loadingKey: keyof LoadingStates,
    operation: () => Promise<void>,
    errorControl?: AbstractControl | null
  ): Promise<void> {
    this.passwordLoading[loadingKey] = true;

    try {
      await operation();
    } catch (error) {
      const errorMessage = this.getErrorMessage(error);

      if (errorControl) {
        errorControl.setErrors({ apiError: { message: errorMessage } });
      }

      this.showError(errorMessage);
    } finally {
      this.passwordLoading[loadingKey] = false;
    }
  }

  private isFormFieldValid(form: FormGroup, fieldName: string): boolean {
    const field = form.get(fieldName);
    return !!(field?.valid && field?.enabled && field?.value);
  }

  private getFormValue(form: FormGroup, fieldName: string): string {
    return form.get(fieldName)?.value || '';
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
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
