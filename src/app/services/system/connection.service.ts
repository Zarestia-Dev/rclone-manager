import { Injectable, inject, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { AppSettingsService } from '../settings/app-settings.service';
import { CheckResult, ConnectionStatus } from '@app/types';

@Injectable({
  providedIn: 'root',
})
export class ConnectionService {
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly translateService = inject(TranslateService);

  readonly status = signal<ConnectionStatus>('online');
  readonly history = signal<{ timestamp: Date; result: CheckResult }[]>([]);
  readonly result = signal<CheckResult | undefined>(undefined);

  async runInternetCheck(): Promise<void> {
    if (this.status() === 'checking') return;

    this.status.set('checking');
    try {
      const links =
        (await this.appSettingsService.getSettingValue<string[]>('core.connection_check_urls')) ||
        [];

      console.debug('Loaded connection check URLs:', links);

      try {
        const result = await this.appSettingsService.checkInternetLinks(
          links,
          2, // retries
          3 // delay in seconds
        );
        console.debug('Connection check result:', result);

        this.result.set(result);
        this.updateHistory(result);

        const isOffline = Object.keys(result.failed || {}).length > 0;
        this.status.set(isOffline ? 'offline' : 'online');
      } catch (err) {
        console.error('Connection check failed:', err);
        const failedResult: CheckResult = { successful: [], failed: {}, retries_used: {} };
        this.result.set(failedResult);
        this.status.set('offline');
        console.error('Connection check failed');
      }
    } catch (err) {
      console.error('Connection check error:', err);
      this.status.set('offline');
      console.error('Failed to load connection check settings');
    }
  }

  getTooltip(): string {
    const currentStatus = this.status();
    if (currentStatus === 'checking') {
      return this.translateService.instant('titlebar.connection.checking');
    }

    const res = this.result();
    if (res && Object.keys(res.failed).length > 0) {
      const services = Object.keys(res.failed)
        .map(url => {
          if (url.includes('google')) return 'Google Drive';
          if (url.includes('dropbox')) return 'Dropbox';
          if (url.includes('onedrive')) return 'OneDrive';
          try {
            return new URL(url).hostname;
          } catch {
            return url;
          }
        })
        .join(', ');

      return this.translateService.instant('titlebar.connection.offline', { services });
    }

    return this.translateService.instant('titlebar.connection.online');
  }

  private updateHistory(result: CheckResult): void {
    const currentHistory = this.history();
    const newEntry = {
      timestamp: new Date(),
      result: result,
    };

    // Keep last 5 entries
    const updated = [newEntry, ...currentHistory].slice(0, 5);
    this.history.set(updated);
  }
}
