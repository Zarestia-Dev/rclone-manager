import { Directive, ElementRef, inject, AfterViewInit, OnDestroy } from '@angular/core';
import { MENU_TRIGGER } from '@angular/cdk/menu';

interface MenuTriggerWithOverlay {
  overlayRef?: {
    updatePosition: () => void;
  } | null;
}

@Directive({
  selector: '[appCdkOverlayAutopos]',
  standalone: true,
})
export class CdkOverlayAutoposDirective implements AfterViewInit, OnDestroy {
  private readonly el = inject(ElementRef<HTMLElement>);
  private readonly trigger = inject(MENU_TRIGGER, {
    optional: true,
  }) as MenuTriggerWithOverlay | null;
  private resizeObserver?: ResizeObserver;

  ngAfterViewInit(): void {
    const node = this.el.nativeElement;
    this.resizeObserver = new ResizeObserver(() => {
      if (this.trigger?.overlayRef) {
        this.trigger.overlayRef.updatePosition();
      }
    });
    this.resizeObserver.observe(node);
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
  }
}
