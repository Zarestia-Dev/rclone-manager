import { Component, HostListener, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { RclonePasswordService } from '@app/services';
import { openUrl } from '@tauri-apps/plugin-opener';
import { FormatTimePipe } from 'src/app/shared/pipes/format-time.pipe';

interface PasswordTab {
  label: string;
  icon: string;
  key: 'overview' | 'security' | 'advanced';
}

interface PasswordValidationState {
  password: string;
  confirmPassword: string;
  newPassword: string;
  confirmNewPassword: string;
  currentPassword: string;
}

interface PasswordLockoutStatus {
  is_locked: boolean;
  failed_attempts: number;
  max_attempts: number;
  remaining_lockout_time?: number;
}

interface PasswordErrors {
  password: string;
  confirmPassword: string;
  newPassword: string;
  confirmNewPassword: string;
  currentPassword: string;
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
  isResettingLockout: boolean;
}

@Component({
  selector: 'app-password-manager-modal',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatInputModule,
    MatFormFieldModule,
    MatIconModule,
  ],
  templateUrl: './password-manager-modal.component.html',
  styleUrls: ['./password-manager-modal.component.scss'],
})
export class PasswordManagerModalComponent implements OnInit {
  private readonly dialogRef = inject(MatDialogRef<PasswordManagerModalComponent>);
  private readonly snackBar = inject(MatSnackBar);
  private readonly passwordService = inject(RclonePasswordService);

  readonly tabs: PasswordTab[] = [
    { label: 'Overview', icon: 'shield', key: 'overview' },
    { label: 'Security', icon: 'lock', key: 'security' },
    { label: 'Advanced', icon: 'wrench', key: 'advanced' },
  ];

  selectedTabIndex = 0;
  bottomTabs = false;

  FormatTimePipe = new FormatTimePipe();

  // Form state
  passwordState: PasswordValidationState = {
    password: '',
    confirmPassword: '',
    newPassword: '',
    confirmNewPassword: '',
    currentPassword: '',
  };

  errors: PasswordErrors = {
    password: '',
    confirmPassword: '',
    newPassword: '',
    confirmNewPassword: '',
    currentPassword: '',
  };

  loading: LoadingStates = {
    isValidating: false,
    isEncrypting: false,
    isUnencrypting: false,
    isChangingPassword: false,
    isStoringPassword: false,
    isRemovingPassword: false,
    isSettingEnv: false,
    isClearingEnv: false,
    isResettingLockout: false,
  };

  // Status flags
  hasStoredPassword = false;
  hasEnvPassword = false;
  isConfigEncrypted: boolean | unknown = false;
  lockoutStatus: PasswordLockoutStatus | null = null;

  get selectedTab(): PasswordTab['key'] {
    return this.tabs[this.selectedTabIndex]?.key || 'overview';
  }

  // Validation methods
  private validatePassword(password: string): string {
    if (!password) return 'Password is required';
    if (password.length < 3) return 'Password must be at least 3 characters';
    if (/['"]/.test(password)) return 'Password cannot contain quotes';
    return '';
  }

  private validatePasswordMatch(password: string, confirmation: string): string {
    if (!confirmation) return 'Please confirm your password';
    if (password !== confirmation) return 'Passwords do not match';
    return '';
  }

  // Form change handlers with immediate validation
  onPasswordChange(): void {
    this.errors.password = this.validatePassword(this.passwordState.password);
    // Re-validate confirmation if it exists
    if (this.passwordState.confirmPassword) {
      this.errors.confirmPassword = this.validatePasswordMatch(
        this.passwordState.password,
        this.passwordState.confirmPassword
      );
    }
  }

  onConfirmPasswordChange(): void {
    this.errors.confirmPassword = this.validatePasswordMatch(
      this.passwordState.password,
      this.passwordState.confirmPassword
    );
  }

  onNewPasswordChange(): void {
    this.errors.newPassword = this.validatePassword(this.passwordState.newPassword);
    // Re-validate confirmation if it exists
    if (this.passwordState.confirmNewPassword) {
      this.errors.confirmNewPassword = this.validatePasswordMatch(
        this.passwordState.newPassword,
        this.passwordState.confirmNewPassword
      );
    }
  }

  onConfirmNewPasswordChange(): void {
    this.errors.confirmNewPassword = this.validatePasswordMatch(
      this.passwordState.newPassword,
      this.passwordState.confirmNewPassword
    );
  }

  onCurrentPasswordChange(): void {
    this.errors.currentPassword = this.validatePassword(this.passwordState.currentPassword);
  }

  // Validation state getters
  get isPasswordValid(): boolean {
    return !this.errors.password && this.passwordState.password.length > 0;
  }

  get isNewPasswordValid(): boolean {
    return !this.errors.newPassword && this.passwordState.newPassword.length > 0;
  }

  get arePasswordsMatching(): boolean {
    return (
      !this.errors.confirmPassword &&
      this.passwordState.confirmPassword.length > 0 &&
      this.passwordState.password === this.passwordState.confirmPassword
    );
  }

  get areNewPasswordsMatching(): boolean {
    return (
      !this.errors.confirmNewPassword &&
      this.passwordState.confirmNewPassword.length > 0 &&
      this.passwordState.newPassword === this.passwordState.confirmNewPassword
    );
  }

  get isCurrentPasswordValid(): boolean {
    return !this.errors.currentPassword && this.passwordState.currentPassword.length > 0;
  }

  // Form validation helpers for encryption
  get canEncrypt(): boolean {
    return this.isPasswordValid && this.arePasswordsMatching;
  }

  get canUnencrypt(): boolean {
    return this.isPasswordValid;
  }

  get canChangePassword(): boolean {
    return this.isCurrentPasswordValid && this.isNewPasswordValid && this.areNewPasswordsMatching;
  }

  get canStorePassword(): boolean {
    return this.isPasswordValid;
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
  async validatePassword2(): Promise<void> {
    if (this.errors.password || !this.passwordState.password) return;

    this.loading.isValidating = true;
    try {
      await this.passwordService.validatePassword(this.passwordState.password);
      this.showSuccess('Password is valid!');
    } catch (error) {
      this.errors.password = 'Invalid password';
      this.showError(this.getErrorMessage(error));
      console.error('Validation failed:', error);
    } finally {
      this.lockoutStatus = await this.passwordService.getLockoutStatus();
      this.loading.isValidating = false;
    }
  }

  async storePassword(): Promise<void> {
    if (!this.canStorePassword) return;

    this.loading.isStoringPassword = true;
    try {
      await this.passwordService.validatePassword(this.passwordState.password);
      await this.passwordService.storePassword(this.passwordState.password);
      this.resetPasswordForm();
      this.showSuccess('Password stored securely in system keychain');
    } catch (error) {
      console.error('Failed to store password:', error);
      this.showError(`Failed to store password: ${this.getErrorMessage(error)}`);
    } finally {
      this.loading.isStoringPassword = false;
      await this.refreshStatus();
    }
  }

  async removePassword(): Promise<void> {
    this.loading.isRemovingPassword = true;
    try {
      await this.passwordService.removeStoredPassword();
      this.showSuccess('Stored password removed from system keychain');
    } catch (error) {
      console.error('Failed to remove password:', error);
      this.showError('Failed to remove stored password');
    } finally {
      this.loading.isRemovingPassword = false;
      await this.refreshStatus();
    }
  }

  async encryptConfig(): Promise<void> {
    if (!this.canEncrypt) return;

    this.loading.isEncrypting = true;
    try {
      await this.passwordService.encryptConfig(this.passwordState.password);
      this.showSuccess('Configuration encrypted successfully');
      this.resetPasswordForm();
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

    this.loading.isUnencrypting = true;
    try {
      await this.passwordService.unencryptConfig(this.passwordState.password);
      this.showSuccess('Configuration unencrypted successfully');
      this.resetPasswordForm();
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

    this.loading.isChangingPassword = true;
    try {
      await this.passwordService.changeConfigPassword(
        this.passwordState.currentPassword,
        this.passwordState.newPassword
      );
      this.showSuccess('Password changed successfully');
      this.resetPasswordForm();
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
      } else {
        this.showError('No stored password found');
      }
      await this.refreshStatus();
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

  // Advanced actions
  async resetLockout(): Promise<void> {
    this.loading.isResettingLockout = true;
    try {
      await this.passwordService.resetLockout();
      this.showSuccess('Security status reset');
      await this.refreshStatus();
    } catch (error) {
      console.error(error);
      this.showError(this.getErrorMessage(error));
    } finally {
      this.loading.isResettingLockout = false;
    }
  }

  // Utility methods
  private async refreshStatus(): Promise<void> {
    try {
      this.hasStoredPassword = await this.passwordService.hasStoredPassword();
      this.hasEnvPassword = await this.passwordService.hasConfigPasswordEnv();
      this.isConfigEncrypted = await this.passwordService.isConfigEncrypted();
      this.lockoutStatus = await this.passwordService.getLockoutStatus();
    } catch (error) {
      console.error(error);
      this.showError(this.getErrorMessage(error));
    }
  }

  private resetPasswordForm(): void {
    this.passwordState = {
      password: '',
      confirmPassword: '',
      newPassword: '',
      confirmNewPassword: '',
      currentPassword: '',
    };
    this.errors = {
      password: '',
      confirmPassword: '',
      newPassword: '',
      confirmNewPassword: '',
      currentPassword: '',
    };
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
    await this.refreshStatus();
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
