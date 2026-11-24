import { inject, signal, WritableSignal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { AppSettingsService } from '../../settings/app-settings.service';
import { NotificationService } from '../../ui/notification.service';
import { UpdateInfo, BackendUpdateStatus } from '@app/types';

/** The release channels the backend knows; it reads any other value as stable. */
export type UpdateChannel = 'stable' | 'beta';

/** A download, installation or staged update that a check, skip or channel change must keep. */
export function isUpdateInFlight(status: BackendUpdateStatus | undefined): boolean {
  return (
    status === BackendUpdateStatus.Downloading ||
    status === BackendUpdateStatus.Installing ||
    status === BackendUpdateStatus.ReadyToRestart
  );
}

export interface UpdateSettingsConfig {
  namespace: string;
  skippedVersionsKey: string;
  updateChannelKey: string;
  autoCheckKey: string;
}

/**
 * Persisted update settings: skipped versions, update channel and the auto-check flag.
 * Created in an injection context (a service field). A failed save is reported here and
 * leaves the setting as it was.
 */
export class UpdateSettingsManager {
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);

  private readonly _skippedVersions = signal<string[]>([]);
  private readonly _updateChannel = signal<UpdateChannel>('stable');
  private readonly _autoCheckEnabled = signal<boolean>(true);

  // Public readonly surface
  public readonly skippedVersions = this._skippedVersions.asReadonly();
  public readonly updateChannel = this._updateChannel.asReadonly();
  public readonly autoCheckEnabled = this._autoCheckEnabled.asReadonly();

  constructor(private readonly config: UpdateSettingsConfig) {}

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
    this._updateChannel.set(channel === 'beta' ? 'beta' : 'stable');
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

  /**
   * Determines if an update is considered available, respecting skipped versions
   * and in-progress/ready update statuses.
   */
  computeAvailableUpdate(update: UpdateInfo | null): UpdateInfo | null {
    if (!update) return null;
    return isUpdateInFlight(update.status) || !this.isVersionSkipped(update.version)
      ? update
      : null;
  }

  /** Adds a version to the skipped list; false when it could not be saved. */
  async skipVersion(version: string): Promise<boolean> {
    const current = this._skippedVersions();
    if (current.includes(version)) return true;
    return this.save(this.config.skippedVersionsKey, this._skippedVersions, [...current, version]);
  }

  /** Removes a version from the skipped list; false when it could not be saved. */
  async unskipVersion(version: string): Promise<boolean> {
    const updated = this._skippedVersions().filter(v => v !== version);
    return this.save(this.config.skippedVersionsKey, this._skippedVersions, updated);
  }

  /** Changes the update channel; false when it could not be saved. */
  async setChannel(channel: UpdateChannel): Promise<boolean> {
    return this.save(this.config.updateChannelKey, this._updateChannel, channel);
  }

  /** Changes the auto-check flag; false when it could not be saved. */
  async setAutoCheckEnabled(enabled: boolean): Promise<boolean> {
    return this.save(this.config.autoCheckKey, this._autoCheckEnabled, enabled);
  }

  private async save<T>(key: string, target: WritableSignal<T>, value: T): Promise<boolean> {
    try {
      await this.appSettingsService.saveSetting(this.config.namespace, key, value);
      target.set(value);
      return true;
    } catch (error) {
      console.error(`Failed to save setting "${this.config.namespace}.${key}":`, error);
      this.notificationService.showError(
        this.translate.instant('modals.about.updateSettingFailed')
      );
      return false;
    }
  }
}
