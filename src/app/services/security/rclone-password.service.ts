import { Injectable } from '@angular/core';
import { PasswordLockoutStatus } from '@app/types';
import { BehaviorSubject } from 'rxjs';
import { invoke } from '@tauri-apps/api/core';

// PasswordLockoutStatus moved to shared types

@Injectable({
  providedIn: 'root',
})
export class RclonePasswordService {
  private passwordRequiredSubject = new BehaviorSubject<boolean>(false);
  public passwordRequired$ = this.passwordRequiredSubject.asObservable();

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
   * Unlock the encrypted rclone config at runtime via RC API
   */
  async unlockConfig(password: string): Promise<void> {
    try {
      await invoke('unlock_rclone_config', { password });
    } catch (error) {
      console.error('Failed to unlock rclone config:', error);
      throw error;
    }
  }

  /**
   * Convenience: try unlocking using stored password if present
   */
  async tryUnlockWithStoredPassword(): Promise<boolean> {
    try {
      const has = await this.hasStoredPassword();
      if (!has) return false;
      const pw = await this.getStoredPassword();
      if (!pw) return false;
      await this.unlockConfig(pw);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if password is set in environment (deprecated, always false)
   */
  async hasConfigPasswordEnv(): Promise<boolean> {
    return false;
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
   * Set password environment variable for current session (deprecated)
   */
  async setConfigPasswordEnv(password: string): Promise<boolean> {
    console.warn('setConfigPasswordEnv is deprecated; use unlockConfig instead');
    await this.unlockConfig(password);
    return true;
  }

  /**
   * Clear password environment variable (deprecated no-op)
   */
  async clearPasswordEnvironment(): Promise<boolean> {
    return true;
  }

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
