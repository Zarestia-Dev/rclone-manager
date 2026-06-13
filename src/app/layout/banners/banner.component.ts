import { Component, inject, signal, isDevMode, ChangeDetectionStrategy } from '@angular/core';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { merge, from, combineLatest, of } from 'rxjs';
import { map, switchMap, catchError } from 'rxjs/operators';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
// Services
import { EventListenersService } from 'src/app/services/infrastructure/system/event-listeners.service';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { SystemInfoService } from 'src/app/services/infrastructure/system/system-info.service';
import { AppUpdaterService } from 'src/app/services/infrastructure/maintenance/app-updater.service';

@Component({
  selector: 'app-banner',
  standalone: true,
  templateUrl: './banner.component.html',
  imports: [MatToolbarModule, MatIconModule, MatTooltipModule, TranslateModule],
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

  readonly showFlatpakWarning = toSignal(
    combineLatest([
      toObservable(this.appUpdaterService.buildType),
      toObservable(this.flatpakDismissed),
    ]).pipe(
      switchMap(([buildType, dismissed]) => {
        // Not a flatpak build, or user already dismissed — hide the banner
        if (buildType !== 'flatpak' || dismissed) return of(false);

        return from(this.appSettingsService.getSettingValue<boolean>('runtime.flatpak_warn')).pipe(
          map(warn => !!warn),
          catchError(() => of(false))
        );
      })
    ),
    { initialValue: false }
  );

  // Merges the initial network state with real-time updates into a single signal.
  readonly isMeteredConnection = toSignal(
    merge(
      from(this.systemInfoService.isNetworkMetered()),
      this.eventListenersService.listenToNetworkStatusChanged().pipe(map(p => p?.isMetered))
    ).pipe(map(v => !!v)),
    { initialValue: false }
  );

  // Listens to the consolidated engine status stream.
  readonly engineError = toSignal(this.eventListenersService.listenToEngineErrorState(), {
    initialValue: null,
  });

  async dismissFlatpakWarning(): Promise<void> {
    this.flatpakDismissed.set(true);
    if (this.appUpdaterService.buildType() === 'flatpak') {
      await this.appSettingsService.saveSetting('runtime', 'flatpak_warn', false);
    }
  }
}
