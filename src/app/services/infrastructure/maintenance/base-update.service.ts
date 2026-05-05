import { inject, signal } from '@angular/core';
import { AppSettingsService } from '../../settings/app-settings.service';
import { TauriBaseService } from '../platform/tauri-base.service';

/**
 * Abstract base for update services.
 * Manages persisted settings: skipped versions, update channel, auto-check flag.
 */
export abstract class BaseUpdateService extends TauriBaseService {
  protected appSettingsService = inject(AppSettingsService);

  protected readonly _skippedVersions = signal<string[]>([]);
  protected readonly _updateChannel = signal<string>('stable');
  protected readonly _autoCheckEnabled = signal<boolean>(true);

  // Public readonly surface
  public readonly skippedVersions = this._skippedVersions.asReadonly();
  public readonly updateChannel = this._updateChannel.asReadonly();
  public readonly autoCheckEnabled = this._autoCheckEnabled.asReadonly();

  protected abstract get settingNamespace(): string;
  protected abstract get skippedVersionsKey(): string;
  protected abstract get updateChannelKey(): string;
  protected abstract get autoCheckKey(): string;

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  protected async initBaseSettings(): Promise<void> {
    const [skipped, channel, autoCheck] = await Promise.all([
      this.loadSetting<string[]>(this.skippedVersionsKey, []),
      this.loadSetting<string>(this.updateChannelKey, 'stable'),
      this.loadSetting<boolean>(this.autoCheckKey, true),
    ]);
    this._skippedVersions.set(Array.isArray(skipped) ? skipped : []);
    this._updateChannel.set(channel ?? 'stable');
    this._autoCheckEnabled.set(autoCheck ?? true);
  }

  private async loadSetting<T>(key: string, fallback: T): Promise<T> {
    try {
      const value = await this.appSettingsService.getSettingValue<T>(
        `${this.settingNamespace}.${key}`
      );
      return value ?? fallback;
    } catch (error) {
      console.error(`Failed to load setting "${this.settingNamespace}.${key}":`, error);
      return fallback;
    }
  }

  // ---------------------------------------------------------------------------
  // Skipped versions
  // ---------------------------------------------------------------------------

  isVersionSkipped(version: string): boolean {
    return this._skippedVersions().includes(version);
  }

  async skipVersion(version: string): Promise<void> {
    const current = this._skippedVersions();
    if (current.includes(version)) return;
    const updated = [...current, version];
    try {
      await this.appSettingsService.saveSetting(
        this.settingNamespace,
        this.skippedVersionsKey,
        updated
      );
      this._skippedVersions.set(updated);
    } catch (error) {
      console.error(`Failed to skip version ${version}:`, error);
    }
  }

  async unskipVersion(version: string): Promise<void> {
    const updated = this._skippedVersions().filter(v => v !== version);
    try {
      await this.appSettingsService.saveSetting(
        this.settingNamespace,
        this.skippedVersionsKey,
        updated
      );
      this._skippedVersions.set(updated);
    } catch (error) {
      console.error(`Failed to unskip version ${version}:`, error);
    }
  }

  // ---------------------------------------------------------------------------
  // Update channel
  // ---------------------------------------------------------------------------

  async setChannel(channel: string): Promise<void> {
    try {
      await this.appSettingsService.saveSetting(
        this.settingNamespace,
        this.updateChannelKey,
        channel
      );
      this._updateChannel.set(channel);
    } catch (error) {
      console.error(`Failed to save update channel:`, error);
    }
  }

  // ---------------------------------------------------------------------------
  // Auto-check
  // ---------------------------------------------------------------------------

  async setAutoCheckEnabled(enabled: boolean): Promise<void> {
    try {
      await this.appSettingsService.saveSetting(this.settingNamespace, this.autoCheckKey, enabled);
      this._autoCheckEnabled.set(enabled);
    } catch (error) {
      console.error(`Failed to save auto-check setting:`, error);
    }
  }
}
