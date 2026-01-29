import { Component, inject, signal, isDevMode, computed } from '@angular/core';
import { MatToolbarModule } from '@angular/material/toolbar';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

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

  // Engine error management - private signals for internal state
  private readonly passwordError = signal(false);
  private readonly pathError = signal(false);
  private readonly genericError = signal(false);

  // Public computed signal - returns current error type or null
  // Priority: password > path > generic
  readonly engineError = computed(() => {
    if (this.passwordError()) return 'password';
    if (this.pathError()) return 'path';
    if (this.genericError()) return 'generic';
    return null;
  });

  // --- INJECTED DEPENDENCIES ---
  private readonly eventListenersService = inject(EventListenersService);
  private readonly systemInfoService = inject(SystemInfoService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly appUpdaterService = inject(AppUpdaterService);

  constructor() {
    this.initializeComponent();
    this.initializeEngineErrorListeners();
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

  /**
   * Listen to engine error events and update the computed signal state
   */
  private initializeEngineErrorListeners(): void {
    // Password error - highest priority
    this.eventListenersService
      .listenToRcloneEnginePasswordError()
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        this.passwordError.set(true);
        this.pathError.set(false);
        this.genericError.set(false);
      });

    // Path error - medium priority
    this.eventListenersService
      .listenToRcloneEnginePathError()
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        this.passwordError.set(false);
        this.pathError.set(true);
        this.genericError.set(false);
      });

    // Generic error - lowest priority
    this.eventListenersService
      .listenToRcloneEngineError()
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        this.passwordError.set(false);
        this.pathError.set(false);
        this.genericError.set(true);
      });

    // Engine ready - clear all errors
    this.eventListenersService
      .listenToRcloneEngineReady()
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        this.passwordError.set(false);
        this.pathError.set(false);
        this.genericError.set(false);
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
