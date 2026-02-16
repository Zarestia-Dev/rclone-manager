import { Component, inject, signal, isDevMode, ChangeDetectionStrategy } from '@angular/core';
import { MatToolbarModule } from '@angular/material/toolbar';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { merge, from, of, combineLatest } from 'rxjs';
import { map, catchError, switchMap } from 'rxjs/operators';

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

  // Metered connection signal: combines initial check and real-time updates
  readonly isMeteredConnection = toSignal(
    merge(
      from(this.systemInfoService.isNetworkMetered()).pipe(
        catchError(() => of(false)),
        map(v => !!v)
      ),
      this.eventListenersService.listenToNetworkStatusChanged().pipe(map(p => !!p?.isMetered))
    ),
    { initialValue: false }
  );

  // Engine error signal: reflects the latest engine state/error event
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

  // Flatpak warning logic
  private readonly flatpakDismissed = signal(false);
  readonly showFlatpakWarning = toSignal(
    combineLatest([this.appUpdaterService.buildType$, toObservable(this.flatpakDismissed)]).pipe(
      switchMap(([buildType, dismissed]) => {
        if (buildType !== 'flatpak' || dismissed) return of(false);
        return from(this.appSettingsService.getSettingValue<boolean>('runtime.flatpak_warn')).pipe(
          map(warn => !!warn),
          catchError(() => of(false))
        );
      })
    ),
    { initialValue: false }
  );

  async dismissFlatpakWarning(): Promise<void> {
    this.flatpakDismissed.set(true);
    await this.appSettingsService.saveSetting('runtime', 'flatpak_warn', false);
  }
}
