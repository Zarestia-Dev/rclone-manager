import { Injectable, inject, Injector } from '@angular/core';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { LoadingOverlayComponent } from '../../shared/components/loading-overlay/loading-overlay.component';

@Injectable({
  providedIn: 'root',
})
export class GlobalLoadingService {
  private overlay = inject(Overlay);
  private injector = inject(Injector);
  private overlayRef: OverlayRef | null = null;
  private componentRef: any = null;

  public show(config?: { title?: string; message?: string; icon?: string }): void {
    if (!this.overlayRef) {
      this.overlayRef = this.overlay.create({
        hasBackdrop: true,
        positionStrategy: this.overlay.position().global().centerHorizontally().centerVertically(),
        scrollStrategy: this.overlay.scrollStrategies.block(),
        backdropClass: 'cdk-overlay-dark-backdrop',
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
