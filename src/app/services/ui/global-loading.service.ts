import { DestroyRef, Injectable, inject, Injector } from '@angular/core';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { LoadingOverlayComponent } from '../../shared/components/loading-overlay/loading-overlay.component';
import { EventListenersService } from '../system/event-listeners.service';
import { TranslateService } from '@ngx-translate/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

@Injectable({
  providedIn: 'root',
})
export class GlobalLoadingService {
  private overlay = inject(Overlay);
  private injector = inject(Injector);
  private eventListenersService = inject(EventListenersService);
  private translateService = inject(TranslateService);
  private destroyRef = inject(DestroyRef);
  private overlayRef: OverlayRef | null = null;
  private componentRef: any = null;
  private shutdownListenerInitialized = false;

  public bindToShutdownEvents(): void {
    if (this.shutdownListenerInitialized) {
      return;
    }

    this.shutdownListenerInitialized = true;
    this.eventListenersService
      .listenToAppEvents()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(event => {
        if (typeof event === 'object' && event?.status === 'shutting_down') {
          this.show({
            title: this.translateService.instant('app.shutdown.title'),
            message: this.translateService.instant('app.shutdown.message'),
            icon: 'refresh',
          });
        }
      });
  }

  public show(config?: { title?: string; message?: string; icon?: string }): void {
    if (!this.overlayRef) {
      this.overlayRef = this.overlay.create({
        hasBackdrop: true,
        positionStrategy: this.overlay.position().global().centerHorizontally().centerVertically(),
        scrollStrategy: this.overlay.scrollStrategies.block(),
      });
    }

    if (!this.overlayRef.hasAttached()) {
      const portal = new ComponentPortal(LoadingOverlayComponent, null, this.injector);
      this.componentRef = this.overlayRef.attach(portal);
    }

    if (this.componentRef) {
      if (config?.title) this.componentRef.setInput('title', config.title);
      if (config?.message) this.componentRef.setInput('message', config.message);
      if (config?.icon) this.componentRef.setInput('icon', config.icon);
    }
  }

  public hide(): void {
    if (this.overlayRef) {
      this.overlayRef.detach();
      this.overlayRef.dispose();
      this.overlayRef = null;
      this.componentRef = null;
    }
  }
}
