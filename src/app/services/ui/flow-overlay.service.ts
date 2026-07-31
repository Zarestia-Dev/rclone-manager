import { Injectable, ComponentRef, inject, signal } from '@angular/core';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { take } from 'rxjs';

import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { isMobile } from '../infrastructure/platform/api-client.service';
import type { FlowContainerComponent } from 'src/app/features/flow/flow-container.component';

@Injectable({ providedIn: 'root' })
export class FlowOverlayService extends TauriBaseService {
  private readonly overlay = inject(Overlay);
  private overlayRef: OverlayRef | null = null;
  private componentRef: ComponentRef<FlowContainerComponent> | null = null;

  private readonly _isFlowOverlayOpen = signal<boolean>(false);
  readonly isFlowOverlayOpen = this._isFlowOverlayOpen.asReadonly();

  private readonly _isStandaloneWindow = signal<boolean>(false);
  readonly isStandaloneWindow = this._isStandaloneWindow.asReadonly();

  constructor() {
    super();
    this._isStandaloneWindow.set(this.detectStandaloneWindow());
  }

  async openFlowOverlay(): Promise<void> {
    if (this.overlayRef) return;
    this._isFlowOverlayOpen.set(true);

    const overlayRef = this.overlay.create({
      positionStrategy: this.overlay.position().global().top('0').left('0').bottom('0'),
      width: '100vw',
      height: '100dvh',
      scrollStrategy: this.overlay.scrollStrategies.block(),
      hasBackdrop: true,
      backdropClass: 'cdk-overlay-dark-backdrop',
    });

    const { FlowContainerComponent } =
      await import('src/app/features/flow/flow-container.component');
    const componentRef = overlayRef.attach(new ComponentPortal(FlowContainerComponent));

    const host = componentRef.location.nativeElement as HTMLElement;
    host.classList.add('slide-overlay-left-enter');
    host.style.width = '100vw';
    host.style.height = '100dvh';

    overlayRef
      .backdropClick()
      .pipe(take(1))
      .subscribe(() => this.closeFlowOverlay());

    this.overlayRef = overlayRef;
    this.componentRef = componentRef;
  }

  closeFlowOverlay(): void {
    if (!this.overlayRef) return;
    this._isFlowOverlayOpen.set(false);

    const overlayRefToDispose = this.overlayRef;
    const componentRefToAnimate = this.componentRef;
    this.overlayRef = null;
    this.componentRef = null;

    componentRefToAnimate?.location.nativeElement.classList.add('slide-overlay-left-leave');
    setTimeout(() => overlayRefToDispose.dispose(), 200);
  }

  toggleFlowOverlay(): void {
    if (this._isFlowOverlayOpen()) {
      this.closeFlowOverlay();
    } else {
      void this.openFlowOverlay();
    }
  }

  async detachToStandaloneWindow(): Promise<void> {
    const url = `${window.location.origin}/flow?standalone=flow`;
    if (this.isTauri && !isMobile()) {
      try {
        await this.invokeCommand('new_window', {
          opts: {
            label: 'flow',
            url,
            title: 'Flow Workspace',
            width: 1024,
            height: 768,
          },
        });
        this.closeFlowOverlay();
        return;
      } catch (err) {
        console.warn('[FlowOverlayService] new_window failed, falling back to window.open:', err);
      }
    }
    window.open(url, '_blank');
    this.closeFlowOverlay();
  }

  private detectStandaloneWindow(): boolean {
    const urlParams = new URLSearchParams(window.location.search);
    const hash = window.location.hash;
    const label = this.getCurrentTauriWindow()?.label;
    return (
      urlParams.get('standalone') === 'flow' ||
      (label?.startsWith('flow') ?? false) ||
      hash.startsWith('#/flow')
    );
  }
}
