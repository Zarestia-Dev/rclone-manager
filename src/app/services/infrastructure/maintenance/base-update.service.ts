import { inject, signal } from '@angular/core';
import { AppSettingsService } from '../../settings/app-settings.service';
import { TauriBaseService } from '../platform/tauri-base.service';

/**
 * Base abstract class for update services.
 * Consolidates common settings for skipped versions, channels, and auto-check flags.
 */
export abstract class BaseUpdateService extends TauriBaseService {
  protected appSettingsService = inject(AppSettingsService);

  protected readonly _skippedVersions = signal<string[]>([]);
  protected readonly _updateChannel = signal<string>('stable');
  protected readonly _autoCheckEnabled = signal<boolean>(true);

  public readonly skippedVersions = this._skippedVersions.asReadonly();
  public readonly updateChannel = this._updateChannel.asReadonly();
  public readonly autoCheckEnabled = this._autoCheckEnabled.asReadonly();

  protected abstract get settingNamespace(): string;
  protected abstract get skippedVersionsKey(): string;
  protected abstract get updateChannelKey(): string;
  protected abstract get autoCheckKey(): string;

  /**
   * Initialize shared update settings
   */
  protected async initBaseSettings(): Promise<void> {
    const [skipped, channel, autoCheck] = await Promise.all([
      this.getSkippedVersions(),
      this.getChannel(),
      this.getAutoCheckEnabled(),
    ]);

    this._skippedVersions.set(skipped);
    this._updateChannel.set(channel);
    this._autoCheckEnabled.set(autoCheck);
  }

  async getSkippedVersions(): Promise<string[]> {
    try {
      const skipped = await this.appSettingsService.getSettingValue<string[]>(
        `${this.settingNamespace}.${this.skippedVersionsKey}`
      );
      return Array.isArray(skipped) ? skipped : [];
    } catch (error) {
      console.error(`Failed to load ${this.skippedVersionsKey}:`, error);
      return [];
    }
  }

  isVersionSkipped(version: string): boolean {
    return this._skippedVersions().includes(version);
  }

  async skipVersion(version: string): Promise<void> {
    try {
      const current = this._skippedVersions();
      if (current.includes(version)) return;

      const updated = [...current, version];
      await this.appSettingsService.saveSetting(
        this.settingNamespace,
        this.skippedVersionsKey,
        updated
      );
      this._skippedVersions.set(updated);
    } catch (error) {
      console.error(`Failed to skip version ${version} for ${this.skippedVersionsKey}:`, error);
    }
  }

  async unskipVersion(version: string): Promise<void> {
    try {
      const current = this._skippedVersions();
      const updated = current.filter(v => v !== version);
      await this.appSettingsService.saveSetting(
        this.settingNamespace,
        this.skippedVersionsKey,
        updated
      );
      this._skippedVersions.set(updated);
    } catch (error) {
      console.error(`Failed to unskip version ${version} for ${this.skippedVersionsKey}:`, error);
    }
  }

  // === Update Channel ===
  async getChannel(): Promise<string> {
    try {
      const channel = await this.appSettingsService.getSettingValue<string>(
        `${this.settingNamespace}.${this.updateChannelKey}`
      );
      return channel || 'stable';
    } catch {
      return 'stable';
    }
  }

  async setChannel(channel: string): Promise<void> {
    try {
      await this.appSettingsService.saveSetting(
        this.settingNamespace,
        this.updateChannelKey,
        channel
      );
      this._updateChannel.set(channel);
    } catch (error) {
      console.error(`Failed to save channel for ${this.updateChannelKey}:`, error);
    }
  }

  // === Auto Check ===
  async getAutoCheckEnabled(): Promise<boolean> {
    try {
      const enabled = await this.appSettingsService.getSettingValue<boolean>(
        `${this.settingNamespace}.${this.autoCheckKey}`
      );
      return enabled ?? true;
    } catch {
      return true;
    }
  }

  async setAutoCheckEnabled(enabled: boolean): Promise<void> {
    try {
      await this.appSettingsService.saveSetting(this.settingNamespace, this.autoCheckKey, enabled);
      this._autoCheckEnabled.set(enabled);
    } catch (error) {
      console.error(`Failed to save auto-check for ${this.autoCheckKey}:`, error);
    }
  }
}
