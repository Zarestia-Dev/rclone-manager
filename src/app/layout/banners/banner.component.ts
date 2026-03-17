import { Component, inject, signal, isDevMode, ChangeDetectionStrategy } from '@angular/core';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { merge, from, combineLatest, of } from 'rxjs';
import { map, switchMap, catchError } from 'rxjs/operators';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
// Services
import {
  EventListenersService,
  AppSettingsService,
  SystemInfoService,
  AppUpdaterService,
} from '@app/services';

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

  // Merges all engine state events into one typed signal.
  readonly engineError = toSignal(
    merge(
      this.eventListenersService
        .listenToRcloneEnginePasswordError()
        .pipe(map(() => 'password' as const)),
      this.eventListenersService.listenToRcloneEnginePathError().pipe(map(() => 'path' as const)),
      this.eventListenersService.listenToRcloneEngineError().pipe(map(() => 'generic' as const)),
      this.eventListenersService.listenToRcloneEngineReady().pipe(map(() => null))
    ),
    { initialValue: null }
  );

  async dismissFlatpakWarning(): Promise<void> {
    this.flatpakDismissed.set(true);
    await this.appSettingsService.saveSetting('runtime', 'flatpak_warn', false);
  }
}
