import { signal } from '@angular/core';
import { AppSettingsService } from '../../settings/app-settings.service';

export interface UpdateSettingsConfig {
  namespace: string;
  skippedVersionsKey: string;
  updateChannelKey: string;
  autoCheckKey: string;
}

/**
 * Manages persisted settings for update services: skipped versions, update channel, and auto-check flag.
 * Provides a cleaner alternative to inheritance-based settings management.
 */
export class UpdateSettingsManager {
  private readonly _skippedVersions = signal<string[]>([]);
  private readonly _updateChannel = signal<string>('stable');
  private readonly _autoCheckEnabled = signal<boolean>(true);

  // Public readonly surface
  public readonly skippedVersions = this._skippedVersions.asReadonly();
  public readonly updateChannel = this._updateChannel.asReadonly();
  public readonly autoCheckEnabled = this._autoCheckEnabled.asReadonly();

  constructor(
    private appSettingsService: AppSettingsService,
    private config: UpdateSettingsConfig
  ) {}

  /**
   * Initializes the settings by loading them from AppSettingsService.
   */
  async initialize(): Promise<void> {
    const [skipped, channel, autoCheck] = await Promise.all([
      this.loadSetting<string[]>(this.config.skippedVersionsKey, []),
      this.loadSetting<string>(this.config.updateChannelKey, 'stable'),
      this.loadSetting<boolean>(this.config.autoCheckKey, true),
    ]);

    this._skippedVersions.set(Array.isArray(skipped) ? skipped : []);
    this._updateChannel.set(channel ?? 'stable');
    this._autoCheckEnabled.set(autoCheck ?? true);
  }

  private async loadSetting<T>(key: string, fallback: T): Promise<T> {
    try {
      const value = await this.appSettingsService.getSettingValue<T>(
        `${this.config.namespace}.${key}`
      );
      return value ?? fallback;
    } catch (error) {
      console.error(`Failed to load setting "${this.config.namespace}.${key}":`, error);
      return fallback;
    }
  }

  /** Checks if a specific version has been marked as skipped. */
  isVersionSkipped(version: string): boolean {
    return this._skippedVersions().includes(version);
  }

  /** Adds a version to the skipped list and persists the change. */
  async skipVersion(version: string): Promise<void> {
    const current = this._skippedVersions();
    if (current.includes(version)) return;

    const updated = [...current, version];
    try {
      await this.saveSetting(this.config.skippedVersionsKey, updated);
      this._skippedVersions.set(updated);
    } catch (error) {
      console.error(`Failed to skip version ${version}:`, error);
    }
  }

  /** Removes a version from the skipped list and persists the change. */
  async unskipVersion(version: string): Promise<void> {
    const updated = this._skippedVersions().filter(v => v !== version);
    try {
      await this.saveSetting(this.config.skippedVersionsKey, updated);
      this._skippedVersions.set(updated);
    } catch (error) {
      console.error(`Failed to unskip version ${version}:`, error);
    }
  }

  /** Updates the update channel (e.g., 'stable', 'beta') and persists the change. */
  async setChannel(channel: string): Promise<void> {
    try {
      await this.saveSetting(this.config.updateChannelKey, channel);
      this._updateChannel.set(channel);
    } catch (error) {
      console.error(`Failed to save update channel:`, error);
    }
  }

  /** Updates the auto-check flag and persists the change. */
  async setAutoCheckEnabled(enabled: boolean): Promise<void> {
    try {
      await this.saveSetting(this.config.autoCheckKey, enabled);
      this._autoCheckEnabled.set(enabled);
    } catch (error) {
      console.error(`Failed to save auto-check setting:`, error);
    }
  }

  private async saveSetting(key: string, value: unknown): Promise<void> {
    await this.appSettingsService.saveSetting(this.config.namespace, key, value);
  }
}
