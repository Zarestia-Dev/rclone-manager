import { Injectable, inject } from '@angular/core';
import { MatBottomSheet, MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { RepairSheetComponent } from '../../features/components/repair-sheet/repair-sheet.component';
import { RepairData } from '../../shared/components/types';

export interface PasswordPromptResult {
  password: string;
  stored: boolean;
}

export interface PasswordLockoutStatus {
  is_locked: boolean;
  failed_attempts: number;
  max_attempts: number;
  remaining_lockout_time?: number;
}

export interface PasswordLockoutStatus {
  is_locked: boolean;
  failed_attempts: number;
  max_attempts: number;
  remaining_lockout_time?: number;
}

@Injectable({
  providedIn: 'root',
})
export class RclonePasswordService {
  private bottomSheet = inject(MatBottomSheet);
  private activePasswordSheet: MatBottomSheetRef<RepairSheetComponent> | null = null;
  private passwordRequiredSubject = new BehaviorSubject<boolean>(false);

  public passwordRequired$ = this.passwordRequiredSubject.asObservable();

  constructor() {
    this.setupEventListeners();
  }

  private async setupEventListeners(): Promise<void> {
    try {
      // Listen for rclone password errors - this is what we see in your logs
      await listen('rclone_engine', (event: { payload: unknown }) => {
        if (typeof event.payload === 'object' && event.payload !== null) {
          const payload = event.payload as {
            status?: string;
            message?: string;
            error_type?: string;
          };
          console.log('🔑 Rclone engine event:', payload);

          // Check for password errors - both old and new format
          if (
            payload.status === 'error' &&
            (payload.error_type === 'password_required' || // New structured format
              (payload.message && this.isPasswordError(payload.message))) // Legacy format
          ) {
            console.log('🔑 Password required detected from engine event');
            this.handlePasswordRequired();
          }
        }
      });
    } catch (error) {
      console.error('Failed to setup password service event listeners:', error);
    }
  }

  private isPasswordError(error: string): boolean {
    const passwordErrorPatterns = [
      'Enter configuration password',
      'Failed to read line: EOF',
      'configuration is encrypted',
      'password required',
      'most likely wrong password.',
    ];

    return passwordErrorPatterns.some(pattern =>
      error.toLowerCase().includes(pattern.toLowerCase())
    );
  }

  private handlePasswordRequired(): void {
    this.passwordRequiredSubject.next(true);

    // Only show one password sheet at a time
    if (this.activePasswordSheet) {
      return;
    }

    this.promptForPassword().catch(error => {
      console.error('Error handling password prompt:', error);
    });
  }

  /**
   * Manually prompt for password (can be called from UI)
   */
  async promptForPassword(options?: {
    title?: string;
    description?: string;
    showStoreOption?: boolean;
    isRequired?: boolean;
  }): Promise<PasswordPromptResult | null> {
    // Close any existing sheet
    if (this.activePasswordSheet) {
      this.activePasswordSheet.dismiss();
    }

    const repairData: RepairData = {
      type: 'rclone_password',
      title: options?.title || 'Rclone Configuration Password Required',
      message:
        options?.description ||
        'Your rclone configuration requires a password to access encrypted remotes.',
      requiresPassword: true,
      showStoreOption: options?.showStoreOption ?? true,
      passwordDescription:
        options?.description ||
        'Your rclone configuration requires a password to access encrypted remotes.',
    };

    this.activePasswordSheet = this.bottomSheet.open(RepairSheetComponent, {
      data: repairData,
      disableClose: options?.isRequired ?? false,
    });

    try {
      const result = await firstValueFrom(this.activePasswordSheet.afterDismissed());
      this.activePasswordSheet = null;
      this.passwordRequiredSubject.next(false);

      if (result === 'success') {
        // The password was successfully validated and applied
        // We don't have direct access to the password here, but that's okay
        // The repair sheet handles setting the environment variable
        return { password: '', stored: false }; // Placeholder values
      }

      return null;
    } catch (error) {
      console.error('Error in password prompt:', error);
      this.activePasswordSheet = null;
      this.passwordRequiredSubject.next(false);
      return null;
    }
  }

  /**
   * Check if password is stored
   */
  async hasStoredPassword(): Promise<boolean> {
    try {
      return await invoke('has_stored_password');
    } catch (error) {
      console.error('Failed to check stored password:', error);
      return false;
    }
  }

  /**
   * Check if password is set in environment
   */
  async hasConfigPasswordEnv(): Promise<boolean> {
    try {
      return await invoke<boolean>('has_config_password_env');
    } catch (error) {
      console.error('Failed to check config password env:', error);
      return false;
    }
  }

  /**
   * Get stored password if available
   */
  async getStoredPassword(): Promise<string | null> {
    try {
      return await invoke('get_config_password');
    } catch (error) {
      console.debug('No stored password found:', error);
      return null;
    }
  }

  /**
   * Store password securely
   */
  async storePassword(password: string): Promise<void> {
    try {
      await invoke('store_config_password', { password });
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  /**
   * Remove stored password
   */
  async removeStoredPassword(): Promise<void> {
    try {
      await invoke('remove_config_password');
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  /**
   * Set password environment variable for current session
   */
  async setConfigPasswordEnv(password: string): Promise<boolean> {
    try {
      await invoke('set_config_password_env', { password });
      return true;
    } catch (error) {
      console.error('Failed to set password environment:', error);
      return false;
    }
  }

  /**
   * Clear password environment variable
   */
  async clearPasswordEnvironment(): Promise<boolean> {
    try {
      await invoke('clear_config_password_env');
      return true;
    } catch (error) {
      console.error('Failed to clear password environment:', error);
      return false;
    }
  }

  /**
   * Initialize password on app startup
   */
  async initializePassword(): Promise<void> {
    // try {
    //   const hasStored = await this.hasStoredPassword();
    //   if (hasStored) {
    //     const password = await this.getStoredPassword();
    //     if (password) {
    //       await this.setPasswordEnvironment(password);
    //       console.log('✅ Rclone password initialized from secure storage');
    //     }
    //   }
    // } catch (error) {
    //   console.error('Failed to initialize password:', error);
    // }
  }

  /**
   * Get lockout status
   */

  /**
   * Reset password validator (clear failed attempts)
   */
  async resetLockout(): Promise<boolean> {
    try {
      await invoke('reset_password_validator');
      return true;
    } catch (error) {
      console.error('Failed to reset password validator:', error);
      return false;
    }
  }

  /**
   * Validate the Rclone config password
   */
  async validatePassword(password: string): Promise<void> {
    try {
      await invoke('validate_rclone_password', { password });
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  /**
   * Get lockout status
   */
  async getLockoutStatus(): Promise<PasswordLockoutStatus | null> {
    try {
      return await invoke('get_password_lockout_status');
    } catch (error) {
      console.error('Failed to get lockout status:', error);
      return null;
    }
  }

  /**
   * Is config encrypted?
   */
  async isConfigEncrypted(): Promise<boolean | unknown> {
    try {
      const result = await invoke('is_config_encrypted');
      console.log(result);

      return result;
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  /**
   * Encrypt the Rclone config
   */
  async encryptConfig(password: string): Promise<void> {
    try {
      await invoke('encrypt_config', { password: password });
    } catch (error) {
      console.error('Failed to encrypt config:', error);
      throw error;
    }
  }

  /**
   * Unencrypt the Rclone config
   */
  async unencryptConfig(password: string): Promise<void> {
    try {
      await invoke('unencrypt_config', { password: password });
    } catch (error) {
      console.error('Failed to unencrypt config:', error);
      throw error;
    }
  }

  /**
   * Change the Rclone config password
   */
  async changeConfigPassword(currentPassword: string, newPassword: string): Promise<void> {
    try {
      await invoke('change_config_password', {
        currentPassword: currentPassword,
        newPassword: newPassword,
      });
    } catch (error) {
      console.error('Failed to change config password:', error);
      throw error;
    }
  }
}
