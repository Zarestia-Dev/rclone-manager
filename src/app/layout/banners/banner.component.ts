import {
  Component,
  inject,
  signal,
  effect,
  isDevMode,
  ChangeDetectionStrategy,
} from '@angular/core';
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
  standalone: true,
  templateUrl: './banner.component.html',
  imports: [MatToolbarModule, MatButtonModule, MatIconModule, MatTooltipModule, TranslateModule],
  styleUrls: ['./banner.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BannerComponent {
  // --- INJECTED DEPENDENCIES ---
  private readonly eventListenersService = inject(EventListenersService);
  private readonly systemInfoService = inject(SystemInfoService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly appUpdaterService = inject(AppUpdaterService);

  // --- STATE SIGNALS ---
  readonly showDevelopmentBanner = signal(isDevMode());

  // Metered connection signal
  readonly isMeteredConnection = signal(false);

  // Engine error signal
  readonly engineError = signal<'password' | 'path' | 'generic' | null>(null);

  // Effect to handle flatpak warning display logic
  constructor() {
    effect(
      () => {
        const buildType = this.appUpdaterService.buildType();
        const dismissed = this.flatpakDismissed();

        if (buildType !== 'flatpak' || dismissed) {
          this.showFlatpakWarning.set(false);
          return;
        }

        this.appSettingsService
          .getSettingValue<boolean>('runtime.flatpak_warn')
          .then(warn => {
            this.showFlatpakWarning.set(!!warn);
          })
          .catch(() => this.showFlatpakWarning.set(false));
      },
      { allowSignalWrites: true }
    );

    // Metered connection real-time updates
    this.systemInfoService
      .isNetworkMetered()
      .then(isMetered => {
        this.isMeteredConnection.set(!!isMetered);
      })
      .catch(() => this.isMeteredConnection.set(false));

    this.eventListenersService.listenToNetworkStatusChanged().subscribe(p => {
      this.isMeteredConnection.set(!!p?.isMetered);
    });

    // Engine error reflecting the latest event
    this.eventListenersService.listenToRcloneEnginePasswordError().subscribe(() => {
      this.engineError.set('password');
    });
    this.eventListenersService.listenToRcloneEnginePathError().subscribe(() => {
      this.engineError.set('path');
    });
    this.eventListenersService.listenToRcloneEngineError().subscribe(() => {
      this.engineError.set('generic');
    });
    this.eventListenersService.listenToRcloneEngineReady().subscribe(() => {
      this.engineError.set(null);
    });
  }

  // Flatpak warning logic
  private readonly flatpakDismissed = signal(false);
  readonly showFlatpakWarning = signal(false);

  async dismissFlatpakWarning(): Promise<void> {
    this.flatpakDismissed.set(true);
    await this.appSettingsService.saveSetting('runtime', 'flatpak_warn', false);
  }
}
