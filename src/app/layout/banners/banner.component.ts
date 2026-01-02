import { Component, inject, signal, isDevMode } from '@angular/core';
import { MatToolbarModule } from '@angular/material/toolbar';

// Services
import {
  EventListenersService,
  AppSettingsService,
  SystemInfoService,
  AppUpdaterService,
} from '@app/services';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';

@Component({
  selector: 'app-banner',
  templateUrl: './banner.component.html',
  standalone: true,
  imports: [MatToolbarModule, MatButtonModule, MatIconModule, MatTooltipModule, TranslateModule],
  styleUrls: ['./banner.component.scss'],
})
export class BannerComponent {
  // --- STATE SIGNALS ---
  readonly isMeteredConnection = signal(false);
  readonly showDevelopmentBanner = signal(isDevMode());
  readonly showFlatpakWarning = signal(false);

  // --- INJECTED DEPENDENCIES ---
  private readonly eventListenersService = inject(EventListenersService);
  private readonly systemInfoService = inject(SystemInfoService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly appUpdaterService = inject(AppUpdaterService);

  constructor() {
    this.initializeComponent();
  }

  private async initializeComponent(): Promise<void> {
    await this.checkMeteredConnection();
    await this.checkBuildTypeAndShowWarning();
    this.eventListenersService.listenToNetworkStatusChanged().subscribe({
      next: payload => {
        this.isMeteredConnection.set(!!payload?.isMetered);
      },
    });
  }

  private async checkBuildTypeAndShowWarning(): Promise<void> {
    try {
      const buildType = await this.appUpdaterService.getBuildType();
      const warningShown =
        await this.appSettingsService.getSettingValue<boolean>('runtime.flatpak_warn');

      if (buildType === 'flatpak' && warningShown) {
        this.showFlatpakWarning.set(true);
      }
    } catch (error) {
      console.error('Failed to check build type:', error);
    }
  }

  async dismissFlatpakWarning(): Promise<void> {
    this.showFlatpakWarning.set(false);
    await this.appSettingsService.saveSetting('runtime', 'flatpak_warn', false);
  }

  private async checkMeteredConnection(): Promise<void> {
    try {
      const isMetered = await this.systemInfoService.isNetworkMetered();
      this.isMeteredConnection.set(!!isMetered);
      console.log('Metered connection status:', this.isMeteredConnection());
    } catch (e) {
      console.error('Failed to check metered connection:', e);
      this.isMeteredConnection.set(false);
    }
  }
}
