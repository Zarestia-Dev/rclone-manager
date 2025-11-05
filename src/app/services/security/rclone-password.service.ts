import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { TauriBaseService } from '../core/tauri-base.service';

// PasswordLockoutStatus moved to shared types

@Injectable({
  providedIn: 'root',
})
export class RclonePasswordService extends TauriBaseService {
  private passwordRequiredSubject = new BehaviorSubject<boolean>(false);
  public passwordRequired$ = this.passwordRequiredSubject.asObservable();

  /**
   * Check if password is stored
   */
  async hasStoredPassword(): Promise<boolean> {
    try {
      return await this.invokeCommand<boolean>('has_stored_password');
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
      return await this.invokeCommand<boolean>('has_config_password_env');
    } catch (error) {
      console.error('Failed to check config password env:', error);
      throw error;
    }
  }

  /**
   * Get stored password if available
   */
  async getStoredPassword(): Promise<string | null> {
    try {
      return await this.invokeCommand<string>('get_config_password');
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
      await this.invokeCommand('store_config_password', { password });
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  /**
   * Clear password from environment variable
   */
  async clearPasswordEnvironment(): Promise<void> {
    try {
      await this.invokeCommand('clear_config_password_env');
    } catch (error) {
      console.error('Failed to clear config password env:', error);
      throw error;
    }
  }

  /**
   * Remove stored password
   */
  async removeStoredPassword(): Promise<void> {
    try {
      await this.invokeCommand('remove_config_password');
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  /**
   * Set password environment variable for current session (deprecated)
   */
  async setConfigPasswordEnv(password: string): Promise<boolean> {
    try {
      await this.invokeCommand('set_config_password_env', { password });
      return true;
    } catch (error) {
      console.error('Failed to set config password env:', error);
      return false;
    }
  }

  /**
   * Validate the Rclone config password
   */
  async validatePassword(password: string): Promise<void> {
    try {
      await this.invokeCommand('validate_rclone_password', { password });
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  /**
   * Is config encrypted? (with caching for performance)
   */
  async isConfigEncryptedCached(): Promise<boolean> {
    try {
      const result = await this.invokeCommand('is_config_encrypted_cached');
      console.log('Cached encryption check result:', result);
      return result as boolean;
    } catch (error) {
      console.error('Failed to check cached encryption status:', error);
      throw error;
    }
  }

  /**
   * Get cached encryption status (no I/O, instant)
   */
  async getCachedEncryptionStatus(): Promise<boolean | null> {
    try {
      const result = await this.invokeCommand('get_cached_encryption_status');
      return result as boolean | null;
    } catch (error) {
      console.error('Failed to get cached encryption status:', error);
      return null;
    }
  }

  /**
   * Clear encryption cache (call when config changes)
   */
  async clearEncryptionCache(): Promise<void> {
    try {
      await this.invokeCommand('clear_encryption_cache');
    } catch (error) {
      console.error('Failed to clear encryption cache:', error);
    }
  }

  /**
   * Is config encrypted?
   */
  async isConfigEncrypted(): Promise<boolean | unknown> {
    try {
      const result = await this.invokeCommand('is_config_encrypted');
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
      await this.invokeCommand('encrypt_config', { password: password });
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
      await this.invokeCommand('unencrypt_config', { password: password });
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
      await this.invokeCommand('change_config_password', {
        currentPassword: currentPassword,
        newPassword: newPassword,
      });
    } catch (error) {
      console.error('Failed to change config password:', error);
      throw error;
    }
  }
}
