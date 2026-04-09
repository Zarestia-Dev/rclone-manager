import { Injectable, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';

@Injectable({
  providedIn: 'root',
})
export class RclonePasswordService extends TauriBaseService {
  private readonly _passwordRequired = signal<boolean>(false);
  public readonly passwordRequired = this._passwordRequired.asReadonly();
  public readonly passwordRequired$ = toObservable(this._passwordRequired);

  /**
   * Check if password is stored
   */
  async hasStoredPassword(): Promise<boolean> {
    return await this.invokeCommand<boolean>('has_stored_password');
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
    await this.invokeWithNotification(
      'store_config_password',
      { password },
      {
        successKey: 'backendSuccess.security.passwordStored',
        errorKey: 'backendErrors.security.storeFailed',
      }
    );
  }

  /**
   * Remove stored password
   */
  async removeStoredPassword(): Promise<void> {
    await this.invokeWithNotification('remove_config_password', undefined, {
      successKey: 'backendSuccess.security.passwordRemoved',
      errorKey: 'backendErrors.security.passwordChangeUnavailable',
    });
  }

  /**
   * Set password environment variable for current session (deprecated)
   */
  async setConfigPasswordEnv(password: string): Promise<boolean> {
    await this.invokeCommand('set_config_password_env', { password });
    return true;
  }

  /**
   * Validate the Rclone config password
   */
  async validatePassword(password: string): Promise<void> {
    await this.invokeWithNotification(
      'validate_rclone_password',
      { password },
      {
        errorKey: 'backendErrors.security.incorrectPassword',
        showSuccess: false,
      }
    );
  }

  /**
   * Is config encrypted?
   */
  async isConfigEncrypted(): Promise<boolean> {
    return await this.invokeCommand<boolean>('is_config_encrypted');
  }

  /**
   * Encrypt the Rclone config
   */
  async encryptConfig(password: string): Promise<void> {
    await this.invokeWithNotification(
      'encrypt_config',
      { password },
      {
        successKey: 'backendSuccess.security.encrypted',
        errorKey: 'backendErrors.security.encryptFailed',
      }
    );
  }

  /**
   * Unencrypt the Rclone config
   */
  async unencryptConfig(password: string): Promise<void> {
    await this.invokeWithNotification(
      'unencrypt_config',
      { password },
      {
        successKey: 'backendSuccess.security.unencrypted',
        errorKey: 'backendErrors.security.decryptFailed',
      }
    );
  }

  /**
   * Change the Rclone config password
   */
  async changeConfigPassword(currentPassword: string, newPassword: string): Promise<void> {
    await this.invokeWithNotification(
      'change_config_password',
      {
        currentPassword,
        newPassword,
      },
      {
        successKey: 'backendSuccess.security.passwordChanged',
        errorKey: 'backendErrors.security.changeFailed',
      }
    );
  }
}
