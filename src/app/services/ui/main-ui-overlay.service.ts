import { Injectable, ComponentRef, inject, signal } from '@angular/core';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { take } from 'rxjs';

import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { isMobile } from '../infrastructure/platform/api-client.service';
import type { MainUiContainerComponent } from 'src/app/layout/main-ui-container.component';

@Injectable({ providedIn: 'root' })
export class MainUiOverlayService extends TauriBaseService {
  private readonly overlay = inject(Overlay);
  private overlayRef: OverlayRef | null = null;
  private componentRef: ComponentRef<MainUiContainerComponent> | null = null;

  private readonly _isMainUiOverlayOpen = signal<boolean>(false);
  readonly isMainUiOverlayOpen = this._isMainUiOverlayOpen.asReadonly();

  private readonly _isStandaloneWindow = signal<boolean>(false);
  readonly isStandaloneWindow = this._isStandaloneWindow.asReadonly();

  constructor() {
    super();
    this._isStandaloneWindow.set(this.detectStandaloneWindow());
  }

  async openMainUiOverlay(): Promise<void> {
    if (this.overlayRef) return;
    this._isMainUiOverlayOpen.set(true);

    const overlayRef = this.overlay.create({
      positionStrategy: this.overlay.position().global().top('0').left('0').bottom('0'),
      width: '100vw',
      height: '100dvh',
      scrollStrategy: this.overlay.scrollStrategies.block(),
      hasBackdrop: true,
      backdropClass: 'cdk-overlay-dark-backdrop',
    });

    const { MainUiContainerComponent } = await import('src/app/layout/main-ui-container.component');
    const componentRef = overlayRef.attach(new ComponentPortal(MainUiContainerComponent));

    const host = componentRef.location.nativeElement as HTMLElement;
    host.classList.add('slide-overlay-left-enter');
    host.style.width = '100vw';
    host.style.height = '100dvh';

    overlayRef
      .backdropClick()
      .pipe(take(1))
      .subscribe(() => this.closeMainUiOverlay());

    this.overlayRef = overlayRef;
    this.componentRef = componentRef;
  }

  closeMainUiOverlay(): void {
    if (!this.overlayRef) return;
    this._isMainUiOverlayOpen.set(false);

    const overlayRefToDispose = this.overlayRef;
    const componentRefToAnimate = this.componentRef;
    this.overlayRef = null;
    this.componentRef = null;

    componentRefToAnimate?.location.nativeElement.classList.add('slide-overlay-left-leave');
    setTimeout(() => overlayRefToDispose.dispose(), 200);
  }

  toggleMainUiOverlay(): void {
    if (this._isMainUiOverlayOpen()) {
      this.closeMainUiOverlay();
    } else {
      void this.openMainUiOverlay();
    }
  }

  async detachToStandaloneWindow(): Promise<void> {
    const url = `${window.location.origin}/?standalone=main`;
    if (this.isTauri && !isMobile()) {
      try {
        await this.invokeCommand('new_window', {
          opts: {
            label: 'main-standalone',
            url,
            title: 'RClone Manager',
            width: 1024,
            height: 768,
          },
        });
        this.closeMainUiOverlay();
        return;
      } catch (err) {
        console.warn('[MainUiOverlayService] new_window failed, falling back to window.open:', err);
      }
    }
    window.open(url, '_blank');
    this.closeMainUiOverlay();
  }

  private detectStandaloneWindow(): boolean {
    const urlParams = new URLSearchParams(window.location.search);
    const hash = window.location.hash;
    const label = this.getCurrentTauriWindow()?.label;
    return (
      urlParams.get('standalone') === 'main' ||
      (label?.startsWith('main-') ?? false) ||
      hash.startsWith('#/main')
    );
  }
}
