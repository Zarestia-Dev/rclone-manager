import {
  Directive,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
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
  private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly longPressDuration = input(1200);
  readonly longPressDisabled = input(false);

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
      this.ngZone.run(() => {
        this.longPressProgress.emit(progress);
      });
    }

    if (progress >= 100) {
      this.hasTriggered = true;
      this.isPressing = false;

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

  private cleanup(): void {
    this.isPressing = false;
    this.lastProgress = 0;
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  ngOnDestroy(): void {
    this.cleanup();
  }
}
