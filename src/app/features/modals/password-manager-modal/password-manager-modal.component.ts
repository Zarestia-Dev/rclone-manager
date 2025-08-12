import { Component, HostListener, OnInit, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { RclonePasswordService } from '@app/services';

interface PasswordTab {
  label: string;
  icon: string;
  key: string;
}

interface PasswordLockoutStatus {
  is_locked: boolean;
  failed_attempts: number;
  max_attempts: number;
  remaining_lockout_time?: number;
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
    MatProgressSpinnerModule,
  ],
  templateUrl: './password-manager-modal.component.html',
  styleUrls: ['./password-manager-modal.component.scss', '../../../styles/_shared-modal.scss'],
})
export class PasswordManagerModalComponent implements OnInit, OnDestroy {
  selectedTabIndex = 0;
  bottomTabs = false;

  // State management
  password = '';
  newPassword = '';
  currentPassword = '';
  hasStoredPassword = false;
  hasEnvPassword = false;
  isConfigEncrypted: boolean | unknown = false;

  // Loading states
  isLoading = false;
  isValidating = false;
  isEncrypting = false;
  isUnencrypting = false;
  isChangingPassword = false;

  lockoutStatus: PasswordLockoutStatus | null = null;
  private unlistenFns: UnlistenFn[] = [];

  readonly tabs: PasswordTab[] = [
    { label: 'Overview', icon: 'circle-info', key: 'overview' },
    { label: 'Security', icon: 'lock', key: 'security' },
    { label: 'Advanced', icon: 'wrench', key: 'advanced' },
  ];

  trackByTab(index: number, tab: PasswordTab): string {
    return tab.key;
  }

  private dialogRef = inject(MatDialogRef<PasswordManagerModalComponent>);
  private snackBar = inject(MatSnackBar);
  private passwordService = inject(RclonePasswordService);

  get selectedTab(): string {
    return this.tabs[this.selectedTabIndex]?.key || 'overview';
  }

  ngOnInit(): void {
    this.onResize();
    this.refreshStatus();
    this.setupEventListeners();
  }

  ngOnDestroy(): void {
    this.unlistenFns.forEach(fn => fn());
  }

  @HostListener('window:resize')
  onResize(): void {
    this.bottomTabs = window.innerWidth < 540;
  }

  selectTab(index: number): void {
    this.selectedTabIndex = index;
  }

  close(): void {
    this.dialogRef.close();
  }

  private async setupEventListeners(): Promise<void> {
    try {
      // Listen for password validation events
      const unlisten1 = await listen(
        'password_validation_result',
        (event: { payload: { is_valid: boolean; message: string } }) => {
          const result = event.payload;
          if (result.is_valid) {
            this.snackBar.open('✅ Password is valid!', 'Close', { duration: 3000 });
          } else {
            this.snackBar.open(`❌ ${result.message}`, 'Close', { duration: 5000 });
          }
        }
      );

      // Listen for lockout events
      const unlisten2 = await listen(
        'password_lockout',
        (event: { payload: { remaining_time: number } }) => {
          const lockout = event.payload;
          this.snackBar.open(
            `🔒 Account locked for ${this.formatTime(lockout.remaining_time)} due to failed attempts`,
            'Close',
            { duration: 8000 }
          );
          this.refreshStatus();
        }
      );

      // Listen for password stored events
      const unlisten3 = await listen('password_stored', () => {
        this.snackBar.open('✅ Password stored securely', 'Close', { duration: 3000 });
        this.refreshStatus();
      });

      // Listen for password removed events
      const unlisten4 = await listen('password_removed', () => {
        this.snackBar.open('🗑️ Password removed', 'Close', { duration: 3000 });
        this.refreshStatus();
      });

      this.unlistenFns = [unlisten1, unlisten2, unlisten3, unlisten4];
    } catch (error) {
      console.error('Failed to setup event listeners:', error);
    }
  }

  async refreshStatus(): Promise<void> {
    try {
      this.hasStoredPassword = await this.passwordService.hasStoredPassword();
      this.hasEnvPassword = await invoke('has_config_password_env');
      this.isConfigEncrypted = await this.passwordService.isConfigEncrypted();
      this.lockoutStatus = await invoke('get_password_lockout_status');
    } catch (error) {
      console.error('Failed to refresh status:', error);
      this.snackBar.open('Failed to refresh status', 'Close', { duration: 3000 });
    }
  }

  // Password actions
  async storePassword(): Promise<void> {
    this.isLoading = true;
    try {
      await this.passwordService.validatePassword(this.password);
      await this.passwordService.storePassword(this.password);
      this.password = '';
      this.snackBar.open('✅ Password stored securely', 'Close', { duration: 3000 });
    } catch (error) {
      console.error(error);
      this.snackBar.open(`${error}`, 'Close', { duration: 3000 });
    } finally {
      this.isLoading = false;
      await this.refreshStatus();
    }
  }

  async validatePassword(): Promise<void> {
    this.isValidating = true;
    try {
      await this.passwordService.validatePassword(this.password);
      this.snackBar.open('✅ Password is valid!', 'Close', { duration: 3000 });
    } catch (error) {
      console.error(error);
      this.snackBar.open(`${error}`, 'Close', { duration: 3000 });
    } finally {
      this.isValidating = false;
      await this.refreshStatus();
    }
  }

  async removePassword(): Promise<void> {
    this.isLoading = true;
    try {
      await this.passwordService.removeStoredPassword();
      this.snackBar.open('🗑️ Password removed', 'Close', { duration: 3000 });
    } catch (error) {
      console.error('Failed to remove password:', error);
      this.snackBar.open('Failed to remove password', 'Close', { duration: 3000 });
    } finally {
      this.isLoading = false;
      await this.refreshStatus();
    }
  }

  // Encryption actions
  async encryptConfig(): Promise<void> {
    if (!this.password) {
      this.snackBar.open('Please enter a password', 'Close', { duration: 3000 });
      return;
    }

    this.isEncrypting = true;
    try {
      await invoke('encrypt_config', { password: this.password });
      this.snackBar.open('✅ Configuration encrypted successfully', 'Close', { duration: 3000 });
      this.password = '';
      await this.refreshStatus();
    } catch (error) {
      console.error('Failed to encrypt configuration:', error);
      this.snackBar.open(`Failed to encrypt configuration: ${error}`, 'Close', { duration: 5000 });
    } finally {
      this.isEncrypting = false;
    }
  }

  async unencryptConfig(): Promise<void> {
    if (!this.password) {
      this.snackBar.open('Please enter the current password', 'Close', { duration: 3000 });
      return;
    }

    this.isUnencrypting = true;
    try {
      await invoke('unencrypt_config', { password: this.password });
      this.snackBar.open('✅ Configuration unencrypted successfully', 'Close', { duration: 3000 });
      this.password = '';
      await this.refreshStatus();
    } catch (error) {
      console.error('Failed to unencrypt configuration:', error);
      this.snackBar.open(`Failed to unencrypt configuration: ${error}`, 'Close', {
        duration: 5000,
      });
    } finally {
      this.isUnencrypting = false;
    }
  }

  async changePassword(): Promise<void> {
    if (!this.currentPassword || !this.newPassword) {
      this.snackBar.open('Please enter both current and new passwords', 'Close', {
        duration: 3000,
      });
      return;
    }

    this.isChangingPassword = true;
    try {
      await invoke('change_config_password', {
        currentPassword: this.currentPassword,
        newPassword: this.newPassword,
      });
      this.snackBar.open('✅ Password changed successfully', 'Close', { duration: 3000 });
      this.currentPassword = '';
      this.newPassword = '';
      await this.refreshStatus();
    } catch (error) {
      console.error('Failed to change password:', error);
      this.snackBar.open(`Failed to change password: ${error}`, 'Close', { duration: 5000 });
    } finally {
      this.isChangingPassword = false;
    }
  }

  // Environment actions
  async setEnvPassword(): Promise<void> {
    this.isLoading = true;
    try {
      const storedPassword = await this.passwordService.getStoredPassword();
      if (storedPassword) {
        await invoke('set_config_password_env', { password: storedPassword });
        this.snackBar.open('✅ Environment variable set', 'Close', { duration: 3000 });
      } else {
        this.snackBar.open('No stored password found', 'Close', { duration: 3000 });
      }
      await this.refreshStatus();
    } catch (error) {
      console.error('Failed to set environment variable:', error);
      this.snackBar.open('Failed to set environment variable', 'Close', { duration: 3000 });
    } finally {
      this.isLoading = false;
    }
  }

  async clearEnvPassword(): Promise<void> {
    this.isLoading = true;
    try {
      await invoke('clear_config_password_env');
      this.snackBar.open('✅ Environment variable cleared', 'Close', { duration: 3000 });
      await this.refreshStatus();
    } catch (error) {
      console.error('Failed to clear environment variable:', error);
      this.snackBar.open('Failed to clear environment variable', 'Close', { duration: 3000 });
    } finally {
      this.isLoading = false;
    }
  }

  // Advanced actions
  async resetValidator(): Promise<void> {
    this.isLoading = true;
    try {
      await invoke('reset_password_validator');
      this.snackBar.open('✅ Security status reset', 'Close', { duration: 3000 });
      await this.refreshStatus();
    } catch (error) {
      console.error('Failed to reset validator:', error);
      this.snackBar.open('Failed to reset security status', 'Close', { duration: 3000 });
    } finally {
      this.isLoading = false;
    }
  }

  async clearAllCredentials(): Promise<void> {
    this.isLoading = true;
    try {
      await invoke('clear_all_credentials');
      this.snackBar.open('✅ All credentials cleared', 'Close', { duration: 3000 });
      await this.refreshStatus();
    } catch (error) {
      console.error('Failed to clear credentials:', error);
      this.snackBar.open('Failed to clear credentials', 'Close', { duration: 3000 });
    } finally {
      this.isLoading = false;
    }
  }

  // Utility functions
  formatTime(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    }
    return `${remainingSeconds}s`;
  }

  isTabDisabled(tabKey: string): boolean {
    switch (tabKey) {
      case 'encryption':
        // Encryption tab needs a password to be entered
        return !this.password && !this.isConfigEncrypted;
      default:
        return false;
    }
  }
}
