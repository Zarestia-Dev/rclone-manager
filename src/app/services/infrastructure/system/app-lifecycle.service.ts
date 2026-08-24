import { DestroyRef, inject, Injectable } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslateService } from '@ngx-translate/core';
import { ApiClientService } from '../platform/api-client.service';
import { EventListenersService } from './event-listeners.service';
import { NotificationService } from '../../ui/notification.service';
import { NautilusService } from '../../ui/nautilus.service';
import { FlowOverlayService } from '../../ui/flow-overlay.service';
import { MainUiOverlayService } from '../../ui/main-ui-overlay.service';

@Injectable({ providedIn: 'root' })
export class AppLifecycleService {
  private readonly eventListenersService = inject(EventListenersService);
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly apiClient = inject(ApiClientService);
  private readonly nautilusService = inject(NautilusService);
  private readonly flowOverlayService = inject(FlowOverlayService);
  private readonly mainUiOverlayService = inject(MainUiOverlayService);
  private readonly destroyRef = inject(DestroyRef);

  private exitListenerInitialized = false;

  public initialize(): void {
    if (this.exitListenerInitialized) {
      return;
    }

    this.exitListenerInitialized = true;

    // Do not handle app exit in secondary standalone windows
    if (this.isStandaloneWindow()) {
      return;
    }

    this.eventListenersService
      .listenToAppExitRequested()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(async summary => {
        const confirmed = await this.notificationService.confirmModal(
          'app.shutdown.confirmTitle',
          this.translate.instant('app.shutdown.confirmMessage', {
            jobs: summary.activeJobsCount,
            mounts: summary.activeMountsCount,
            serves: summary.activeServesCount,
          }),
          'app.shutdown.stopAndQuit',
          'common.cancel',
          { icon: 'warning', color: 'warn' }
        );

        if (confirmed) {
          await this.apiClient.invoke('shutdown_app');
        }
      });
  }

  private isStandaloneWindow(): boolean {
    return (
      this.nautilusService.isStandaloneWindow() ||
      this.flowOverlayService.isStandaloneWindow() ||
      this.mainUiOverlayService.isStandaloneWindow()
    );
  }
}
