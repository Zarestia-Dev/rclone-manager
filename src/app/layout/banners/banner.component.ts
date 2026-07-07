import {
  Component,
  inject,
  signal,
  isDevMode,
  ChangeDetectionStrategy,
  computed,
} from '@angular/core';
import { toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslatePipe } from '@ngx-translate/core';
// Services
import { EventListenersService } from 'src/app/services/infrastructure/system/event-listeners.service';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { SystemInfoService } from 'src/app/services/infrastructure/system/system-info.service';
import { AppUpdaterService } from 'src/app/services/infrastructure/maintenance/app-updater.service';

@Component({
  selector: 'app-banner',
  templateUrl: './banner.component.html',
  imports: [MatToolbarModule, MatIconModule, MatTooltipModule, TranslatePipe],
  styleUrls: ['./banner.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BannerComponent {
  private readonly eventListenersService = inject(EventListenersService);
  private readonly systemInfoService = inject(SystemInfoService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly appUpdaterService = inject(AppUpdaterService);

  readonly showDevelopmentBanner = signal(isDevMode());
  readonly minRcloneVersion = this.systemInfoService.minRcloneVersion;
  private readonly flatpakDismissed = signal(false);

  readonly showFlatpakWarning = computed(() => {
    const buildType = this.appUpdaterService.buildType();
    const dismissed = this.flatpakDismissed();
    if (buildType !== 'flatpak' || dismissed) return false;

    return !!this.appSettingsService.options()?.['runtime.flatpak_warn']?.value;
  });

  // Merges the initial network state with real-time updates into a single signal.
  readonly isMeteredConnection = signal(false);

  // Listens to the consolidated engine status stream.
  readonly engineError = toSignal(this.eventListenersService.listenToEngineErrorState(), {
    initialValue: null,
  });

  constructor() {
    this.systemInfoService.isNetworkMetered().then(isMetered => {
      this.isMeteredConnection.set(isMetered);
    });

    this.eventListenersService
      .listenToNetworkStatusChanged()
      .pipe(takeUntilDestroyed())
      .subscribe(p => {
        this.isMeteredConnection.set(!!p?.isMetered);
      });
  }

  async dismissFlatpakWarning(): Promise<void> {
    this.flatpakDismissed.set(true);
    if (this.appUpdaterService.buildType() === 'flatpak') {
      await this.appSettingsService.saveSetting('runtime', 'flatpak_warn', false);
    }
  }
}
