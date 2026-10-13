import { Injectable, ComponentRef, inject, signal, Type } from '@angular/core';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { take } from 'rxjs';

import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { isMobile } from '../infrastructure/platform/api-client.service';

@Injectable()
export abstract class BaseSlideOverlayService<T> extends TauriBaseService {
  protected readonly overlay = inject(Overlay);

  protected overlayRef: OverlayRef | null = null;
  protected componentRef: ComponentRef<T> | null = null;
  private isOpening = false;

  protected readonly _isOpen = signal<boolean>(false);
  readonly isOpen = this._isOpen.asReadonly();

  protected readonly _isStandaloneWindow = signal<boolean>(false);
  readonly isStandaloneWindow = this._isStandaloneWindow.asReadonly();

  protected abstract loadComponent(): Promise<Type<T>>;
  protected abstract getStandaloneConfig(): { url: string; label: string; title: string };
  protected abstract detectStandaloneWindow(): boolean;

  constructor() {
    super();
    this._isStandaloneWindow.set(this.detectStandaloneWindow());
  }

  async openOverlay(): Promise<void> {
    if (this.overlayRef || this.isOpening) return;
    this.isOpening = true;
    this._isOpen.set(true);

    const overlayRef = this.overlay.create({
      positionStrategy: this.overlay.position().global().top('0').left('0').bottom('0'),
      width: '100vw',
      height: '100dvh',
      scrollStrategy: this.overlay.scrollStrategies.block(),
    });

    try {
      const componentType = await this.loadComponent();
      const componentRef = overlayRef.attach(new ComponentPortal(componentType));

      const host = componentRef.location.nativeElement as HTMLElement;
      host.classList.add('slide-overlay-left-enter');
      host.style.width = '100vw';
      host.style.height = '100dvh';

      overlayRef
        .backdropClick()
        .pipe(take(1))
        .subscribe(() => this.closeOverlay());

      this.overlayRef = overlayRef;
      this.componentRef = componentRef;
    } finally {
      this.isOpening = false;
    }
  }

  closeOverlay(): void {
    if (!this.overlayRef) return;
    this._isOpen.set(false);

    const overlayRefToDispose = this.overlayRef;
    const componentRefToAnimate = this.componentRef;
    this.overlayRef = null;
    this.componentRef = null;

    componentRefToAnimate?.location.nativeElement.classList.add('slide-overlay-left-leave');
    setTimeout(() => overlayRefToDispose.dispose(), 200);
  }

  toggleOverlay(): void {
    if (this._isOpen()) {
      this.closeOverlay();
    } else {
      void this.openOverlay();
    }
  }

  async detachToStandaloneWindow(): Promise<void> {
    const config = this.getStandaloneConfig();
    if (this.isTauri && !isMobile()) {
      try {
        await this.invokeCommand('new_window', {
          opts: {
            label: config.label,
            url: config.url,
            title: config.title,
            width: 1024,
            height: 768,
          },
        });
        this.closeOverlay();
        return;
      } catch (err) {
        console.warn(
          `[${this.constructor.name}] new_window failed, falling back to window.open:`,
          err
        );
      }
    }
    window.open(config.url, '_blank');
    this.closeOverlay();
  }
}
