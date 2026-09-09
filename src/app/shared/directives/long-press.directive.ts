import {
  Directive,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
  Renderer2,
  inject,
  input,
  output,
} from '@angular/core';

@Directive({
  selector: '[appLongPress]',
  standalone: true,
})
export class LongPressDirective implements OnDestroy {
  private readonly ngZone = inject(NgZone);
  private readonly renderer = inject(Renderer2);
  private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly longPressDuration = input(1200);
  readonly longPressDisabled = input(false);
  readonly showIndicator = input(true);
  readonly indicatorColor = input<string>('var(--warn-color)');

  readonly longPress = output<void>();
  readonly longPressProgress = output<number>();
  readonly longPressCancel = output<void>();

  private startTime = 0;
  private animFrameId: number | null = null;
  private isPressing = false;
  private hasTriggered = false;
  private startX = 0;
  private startY = 0;
  private lastProgress = 0;
  private readonly moveThreshold = 10;

  private indicatorEl: HTMLElement | null = null;
  private originalPosition: string | null = null;

  private get isDisabled(): boolean {
    return (
      this.longPressDisabled() ||
      Boolean(this.elementRef?.nativeElement?.hasAttribute('disabled')) ||
      Boolean((this.elementRef?.nativeElement as HTMLButtonElement)?.disabled)
    );
  }

  @HostListener('pointerdown', ['$event'])
  onPointerDown(event: PointerEvent): void {
    if (this.isDisabled || event.button !== 0) {
      return;
    }

    this.isPressing = true;
    this.hasTriggered = false;
    this.startX = event.clientX;
    this.startY = event.clientY;
    this.startTime = Date.now();
    this.lastProgress = 0;

    // Run outside Angular zone to avoid triggering change detection on every RAF frame
    this.ngZone.runOutsideAngular(() => {
      this.tick();
    });
  }

  @HostListener('pointermove', ['$event'])
  onPointerMove(event: PointerEvent): void {
    if (!this.isPressing) {
      return;
    }

    const dx = event.clientX - this.startX;
    const dy = event.clientY - this.startY;
    if (Math.hypot(dx, dy) > this.moveThreshold) {
      this.onPointerEnd();
    }
  }

  @HostListener('pointerup')
  @HostListener('pointercancel')
  @HostListener('pointerleave')
  onPointerEnd(): void {
    if (!this.isPressing) {
      return;
    }

    const wasTriggered = this.hasTriggered;
    this.cleanup();

    if (!wasTriggered) {
      this.ngZone.run(() => {
        this.longPressProgress.emit(0);
        this.longPressCancel.emit();
      });
    }
  }

  @HostListener('click', ['$event'])
  onClick(event: MouseEvent): void {
    if (this.hasTriggered) {
      event.preventDefault();
      event.stopPropagation();
      this.hasTriggered = false;
    }
  }

  @HostListener('contextmenu', ['$event'])
  onContextMenu(event: MouseEvent): void {
    if (this.isPressing || this.hasTriggered) {
      event.preventDefault();
    }
  }

  private tick(): void {
    if (!this.isPressing) {
      return;
    }

    const elapsed = Date.now() - this.startTime;
    const progress = Math.min(100, Math.round((elapsed / this.longPressDuration()) * 100));

    if (progress !== this.lastProgress) {
      this.lastProgress = progress;

      if (this.showIndicator()) {
        this.updateIndicator(progress);
      }

      this.ngZone.run(() => {
        this.longPressProgress.emit(progress);
      });
    }

    if (progress >= 100) {
      this.hasTriggered = true;
      this.isPressing = false;
      this.removeIndicator();

      // Haptic feedback for mobile/touch
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        try {
          navigator.vibrate?.([40]);
        } catch {
          // Ignore vibration errors on unsupported devices
        }
      }

      this.ngZone.run(() => {
        this.longPress.emit();
        // Reset progress after a brief tick
        this.longPressProgress.emit(0);
      });
      return;
    }

    this.animFrameId = requestAnimationFrame(() => this.tick());
  }

  private updateIndicator(progress: number): void {
    const host = this.elementRef.nativeElement;
    if (!host) return;

    if (!this.indicatorEl) {
      // Ensure host has a non-static position for absolute child placement
      const currentPos = host.style.position || window.getComputedStyle?.(host)?.position;
      if (!currentPos || currentPos === 'static') {
        this.originalPosition = host.style.position;
        this.renderer.setStyle(host, 'position', 'relative');
      }

      this.indicatorEl = this.renderer.createElement('span');
      this.renderer.addClass(this.indicatorEl, 'long-press-progress-bar');
      this.renderer.setStyle(this.indicatorEl, 'position', 'absolute');
      this.renderer.setStyle(this.indicatorEl, 'bottom', '0');
      this.renderer.setStyle(this.indicatorEl, 'left', '0');
      this.renderer.setStyle(this.indicatorEl, 'height', '3px');
      this.renderer.setStyle(this.indicatorEl, 'backgroundColor', this.indicatorColor());
      this.renderer.setStyle(this.indicatorEl, 'pointerEvents', 'none');
      this.renderer.setStyle(this.indicatorEl, 'transition', 'width 0.04s linear');
      this.renderer.setStyle(this.indicatorEl, 'zIndex', '10');
      this.renderer.setStyle(this.indicatorEl, 'borderRadius', 'inherit');

      this.renderer.appendChild(host, this.indicatorEl);
      this.renderer.addClass(host, 'is-long-pressing');
    }

    this.renderer.setStyle(this.indicatorEl, 'width', `${progress}%`);
    this.renderer.setStyle(host, '--long-press-progress', `${progress}%`);
  }

  private removeIndicator(): void {
    const host = this.elementRef.nativeElement;
    if (this.indicatorEl) {
      this.renderer.removeChild(host, this.indicatorEl);
      this.indicatorEl = null;
    }
    if (host) {
      this.renderer.removeClass(host, 'is-long-pressing');
      this.renderer.removeStyle(host, '--long-press-progress');
      if (this.originalPosition !== null) {
        if (this.originalPosition) {
          this.renderer.setStyle(host, 'position', this.originalPosition);
        } else {
          this.renderer.removeStyle(host, 'position');
        }
        this.originalPosition = null;
      }
    }
  }

  private cleanup(): void {
    this.isPressing = false;
    this.lastProgress = 0;
    this.removeIndicator();
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  ngOnDestroy(): void {
    this.cleanup();
  }
}
