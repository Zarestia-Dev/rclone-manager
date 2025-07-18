import { inject, Injectable } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';
import { NotificationService } from '../../shared/services/notification.service';
import { CheckResult } from '../../shared/components/types';

/**
 * Service for application settings management
 * Handles settings CRUD operations and validation
 */
@Injectable({
  providedIn: 'root',
})
export class AppSettingsService extends TauriBaseService {
  private notificationService = inject(NotificationService);

  constructor() {
    super();
  }

  /**
   * Load all settings
   */
  async loadSettings(): Promise<any> {
    return this.invokeCommand('load_settings');
  }

  /**
   * Load a specific setting value
   */
  async loadSettingValue(category: string, key: string): Promise<any> {
    return this.invokeCommand('load_setting_value', { category, key });
  }

  /**
   * Save a setting
   */
  async saveSetting(category: string, key: string, value: any): Promise<void> {
    const updatedSetting = { [category]: { [key]: value } };
    console.log('Saving setting:', category, key, value);

    return this.invokeCommand('save_settings', { updatedSettings: updatedSetting });
  }

  /**
   * Save remote-specific settings
   */
  async saveRemoteSettings(remoteName: string, settings: any): Promise<void> {
    return this.invokeCommand('save_remote_settings', { remoteName, settings });
  }

  /**
   * Get remote settings
   */
  async getRemoteSettings(): Promise<any> {
    return this.invokeCommand('get_settings');
  }

  /**
   * Reset all settings
   */
  async resetSettings(): Promise<boolean> {
    const confirmed = await this.notificationService.confirmModal(
      'Reset Settings',
      'Are you sure you want to reset all settings? This action cannot be undone.'
    );

    if (confirmed) {
      await this.invokeCommand('reset_settings');
      this.notificationService.showSuccess('Settings reset successfully');
      return true;
    }

    return false;
  }

  /**
   * Reset settings for a specific remote
   */
  async resetRemoteSettings(remoteName: string): Promise<void> {
    await this.invokeCommand('delete_remote_settings', { remoteName });
    this.notificationService.showSuccess(`Settings for ${remoteName} reset successfully`);
  }

  /**
   * Check internet connectivity for links
   */
  async checkInternetLinks(
    links: string,
    maxRetries: number,
    retryDelaySecs: number
  ): Promise<CheckResult> {
    return this.invokeCommand<CheckResult>('check_links', {
      links,
      maxRetries,
      retryDelaySecs,
    });
  }
}
