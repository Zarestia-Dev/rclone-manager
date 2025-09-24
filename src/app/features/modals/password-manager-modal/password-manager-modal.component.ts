import { Component, HostListener, OnInit, inject } from '@angular/core';

import {
  ReactiveFormsModule,
  FormBuilder,
  FormGroup,
  Validators,
  AbstractControl,
  ValidationErrors,
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { RclonePasswordService } from '@app/services';
import { openUrl } from '@tauri-apps/plugin-opener';
import { FormatTimePipe } from 'src/app/shared/pipes/format-time.pipe';
import { LoadingStates, PasswordTab } from '@app/types';

@Component({
  selector: 'app-password-manager-modal',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatInputModule,
    MatFormFieldModule,
    MatIconModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: './password-manager-modal.component.html',
  styleUrls: ['./password-manager-modal.component.scss'],
})
export class PasswordManagerModalComponent implements OnInit {
  private readonly dialogRef = inject(MatDialogRef<PasswordManagerModalComponent>);
  private readonly snackBar = inject(MatSnackBar);
  private readonly passwordService = inject(RclonePasswordService);
  private readonly fb = inject(FormBuilder);

  readonly tabs: PasswordTab[] = [
    { label: 'Overview', icon: 'shield', key: 'overview' },
    { label: 'Security', icon: 'lock', key: 'security' },
    { label: 'Advanced', icon: 'wrench', key: 'advanced' },
  ];

  selectedTabIndex = 0;
  bottomTabs = false;

  FormatTimePipe = new FormatTimePipe();

  // Reactive Forms
  overviewForm: FormGroup;
  encryptionForm: FormGroup;
  changePasswordForm: FormGroup;

  loading: LoadingStates = {
    isValidating: false,
    isEncrypting: false,
    isUnencrypting: false,
    isChangingPassword: false,
    isStoringPassword: false,
    isRemovingPassword: false,
    isResettingLockout: false,
    isSettingEnv: false,
    isClearingEnv: false,
  };

  // Status flags
  hasStoredPassword = false;
  hasEnvPassword = false;
  isConfigEncrypted: boolean | null = null; // null = loading, true/false = actual state

  // Loading state for initial data fetch
  isInitialLoading = true;

  constructor() {
    this.overviewForm = this.createOverviewForm();
    this.encryptionForm = this.createEncryptionForm();
    this.changePasswordForm = this.createChangePasswordForm();
  }

  get selectedTab(): PasswordTab['key'] {
    return this.tabs[this.selectedTabIndex]?.key || 'overview';
  }

  // Status helper getters
  get isLoadingData(): boolean {
    return this.isInitialLoading || this.isConfigEncrypted === null;
  }

  get isEncryptedConfig(): boolean {
    return this.isConfigEncrypted === true;
  }

  get isUnencryptedConfig(): boolean {
    return this.isConfigEncrypted === false;
  }

  // Form creation methods
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

  // Custom validators
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

  // Form validation getters
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

  // UI Actions
  switchToSecurityTab(): void {
    this.selectedTabIndex = this.tabs.findIndex(tab => tab.key === 'security');
  }

  learnMoreAboutEncryption(): void {
    openUrl('https://rclone.org/docs/#configuration-encryption').catch(err => {
      console.error('Failed to open URL:', err);
      this.showError('Failed to open documentation');
    });
  }

  // Core functionality
  async validatePassword(): Promise<void> {
    const passwordControl = this.overviewForm.get('password');
    if (!passwordControl?.valid || !passwordControl?.value) return;

    this.loading.isValidating = true;
    try {
      await this.passwordService.validatePassword(passwordControl.value);
      this.showSuccess('Password is valid!');
    } catch (error) {
      passwordControl.setErrors({ apiError: { message: 'Invalid password' } });
      this.showError(this.getErrorMessage(error));
      console.error('Validation failed:', error);
    } finally {
      this.loading.isValidating = false;
    }
  }

  async storePassword(): Promise<void> {
    if (!this.canStorePassword) return;

    const passwordControl = this.overviewForm.get('password');
    if (!passwordControl?.value) return;

    this.loading.isStoringPassword = true;
    try {
      await this.passwordService.validatePassword(passwordControl.value);
      await this.passwordService.storePassword(passwordControl.value);
      this.resetPasswordForms();
      this.showSuccess('Password stored securely in system keychain');
      await this.refreshStatus();
    } catch (error) {
      console.error('Failed to store password:', error);
      this.showError(`Failed to store password: ${this.getErrorMessage(error)}`);
    } finally {
      this.loading.isStoringPassword = false;
    }
  }

  async removePassword(): Promise<void> {
    this.loading.isRemovingPassword = true;
    try {
      await this.passwordService.removeStoredPassword();
      this.showSuccess('Stored password removed from system keychain');
      await this.refreshStatus();
    } catch (error) {
      console.error('Failed to remove password:', error);
      this.showError('Failed to remove stored password');
    } finally {
      this.loading.isRemovingPassword = false;
    }
  }

  async encryptConfig(): Promise<void> {
    if (!this.canEncrypt) return;

    const passwordControl = this.encryptionForm.get('password');
    if (!passwordControl?.value) return;

    this.loading.isEncrypting = true;
    try {
      await this.passwordService.encryptConfig(passwordControl.value);
      // Clear encryption cache since status changed
      await this.passwordService.clearEncryptionCache();
      this.showSuccess('Configuration encrypted successfully');
      this.resetPasswordForms();
      await this.refreshStatus();
    } catch (error) {
      console.error('Failed to encrypt configuration:', error);
      this.showError(`Failed to encrypt configuration: ${this.getErrorMessage(error)}`);
    } finally {
      this.loading.isEncrypting = false;
    }
  }

  async unencryptConfig(): Promise<void> {
    if (!this.canUnencrypt) return;

    const passwordControl = this.encryptionForm.get('password');
    if (!passwordControl?.value) return;

    this.loading.isUnencrypting = true;
    try {
      await this.passwordService.unencryptConfig(passwordControl.value);
      // Clear encryption cache since status changed
      await this.passwordService.clearEncryptionCache();
      this.showSuccess('Configuration unencrypted successfully');
      this.resetPasswordForms();
      await this.refreshStatus();
    } catch (error) {
      console.error('Failed to unencrypt configuration:', error);
      this.showError(`Failed to unencrypt configuration: ${this.getErrorMessage(error)}`);
    } finally {
      this.loading.isUnencrypting = false;
    }
  }

  async changePassword(): Promise<void> {
    if (!this.canChangePassword) return;

    const currentPasswordControl = this.changePasswordForm.get('currentPassword');
    const newPasswordControl = this.changePasswordForm.get('newPassword');

    if (!currentPasswordControl?.value || !newPasswordControl?.value) return;

    this.loading.isChangingPassword = true;
    try {
      await this.passwordService.changeConfigPassword(
        currentPasswordControl.value,
        newPasswordControl.value
      );
      // Clear encryption cache since password changed
      await this.passwordService.clearEncryptionCache();
      this.showSuccess('Password changed successfully');
      this.resetPasswordForms();
      await this.refreshStatus();
    } catch (error) {
      console.error('Failed to change password:', error);
      this.showError(`Failed to change password: ${this.getErrorMessage(error)}`);
    } finally {
      this.loading.isChangingPassword = false;
    }
  }

  // Environment actions
  async setEnvPassword(): Promise<void> {
    this.loading.isSettingEnv = true;
    try {
      const storedPassword = await this.passwordService.getStoredPassword();
      if (storedPassword) {
        await this.passwordService.setConfigPasswordEnv(storedPassword);
        this.showSuccess('Environment variable set');
        await this.refreshStatus();
      } else {
        this.showError('No stored password found');
      }
    } catch (error) {
      console.error('Failed to set environment variable:', error);
      this.showError('Failed to set environment variable');
    } finally {
      this.loading.isSettingEnv = false;
    }
  }

  async clearEnvPassword(): Promise<void> {
    this.loading.isClearingEnv = true;
    try {
      await this.passwordService.clearPasswordEnvironment();
      this.showSuccess('Environment variable cleared');
      await this.refreshStatus();
    } catch (error) {
      console.error('Failed to clear environment variable:', error);
      this.showError('Failed to clear environment variable');
    } finally {
      this.loading.isClearingEnv = false;
    }
  }

  // Utility methods
  private async refreshStatus(): Promise<void> {
    try {
      // For initial load, show loading state
      if (this.isInitialLoading) {
        this.isConfigEncrypted = null; // null indicates loading
      }

      // First try to get cached encryption status for instant response
      const cachedStatus = await this.passwordService.getCachedEncryptionStatus();
      if (cachedStatus !== null && this.isInitialLoading) {
        this.isConfigEncrypted = cachedStatus;
        console.log('💾 Using cached encryption status for instant load:', cachedStatus);
      }

      // Set a reasonable timeout to prevent infinite loading
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Status check timeout')), 5000); // Reduced to 5 seconds
      });

      // Fetch all status information in parallel for better performance
      const statusPromise = Promise.all([
        this.passwordService.hasStoredPassword(),
        this.passwordService.hasConfigPasswordEnv(),
        this.passwordService.isConfigEncryptedCached(), // Always use cached version for better performance
      ]);

      const [hasStored, hasEnv, isEncrypted] = (await Promise.race([
        statusPromise,
        timeoutPromise,
      ])) as [boolean, boolean, boolean, null];

      this.hasStoredPassword = hasStored;
      this.hasEnvPassword = hasEnv;
      this.isConfigEncrypted = isEncrypted;

      // Update form states after getting lockout status
      this.updateFormStatesBasedOnLockout();
    } catch (error) {
      console.error('Failed to refresh status:', error);

      // Only show error if it's not a timeout and we don't have cached data
      if (this.isConfigEncrypted === null) {
        this.showError('Failed to load configuration status');
        // Set safe defaults on error
        this.isConfigEncrypted = false;
      }

      this.hasStoredPassword = false;
      this.hasEnvPassword = false;
    } finally {
      this.isInitialLoading = false;
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

  // Lifecycle hooks
  async ngOnInit(): Promise<void> {
    this.onResize();

    // Try to load cached encryption status immediately for better UX
    this.loadCachedStatusQuickly();

    // Start loading full status in the background
    this.refreshStatus().catch(error => {
      console.error('Initial status load failed:', error);
      this.isInitialLoading = false;
    });

    this.updateFormStatesBasedOnLockout();
  }

  // Quick load cached status for instant UI updates
  private async loadCachedStatusQuickly(): Promise<void> {
    try {
      const cachedStatus = await this.passwordService.getCachedEncryptionStatus();
      if (cachedStatus !== null) {
        this.isConfigEncrypted = cachedStatus;
        console.log('🚀 Instant load with cached encryption status:', cachedStatus);
      }
    } catch (error) {
      console.debug('No cached status available:', error);
    }
  }

  // Update form disabled states based on lockout status
  private updateFormStatesBasedOnLockout(): void {
    this.overviewForm.get('password')?.enable();
    this.encryptionForm.get('password')?.enable();
    this.encryptionForm.get('confirmPassword')?.enable();
    this.changePasswordForm.enable();
  }

  @HostListener('window:resize')
  private onResize(): void {
    this.bottomTabs = window.innerWidth < 540;
  }

  // UI Actions
  selectTab(index: number): void {
    this.selectedTabIndex = index;
  }

  @HostListener('document:keydown.escape', ['$event'])
  close(): void {
    this.dialogRef.close();
  }
}
