import {
  Directive,
  ElementRef,
  output,
  inject,
  afterNextRender,
  DestroyRef,
  HostListener,
  NgZone,
} from '@angular/core';

@Directive({
  selector: '[appScrollShadow]',
  standalone: true,
})
export class ScrollShadowDirective {
  /** Emits when the left shadow should be visible. */
  public readonly leftShadow = output<boolean>();

  /** Emits when the right shadow should be visible. */
  public readonly rightShadow = output<boolean>();

  private readonly el = inject(ElementRef).nativeElement as HTMLElement;
  private readonly destroyRef = inject(DestroyRef);
  private readonly ngZone = inject(NgZone);
  private _resizeObserver?: ResizeObserver;

  constructor() {
    afterNextRender(() => {
      this.updateShadows();

      // Run ResizeObserver outside of Angular zone to avoid unnecessary change detection cycles
      this.ngZone.runOutsideAngular(() => {
        this._resizeObserver = new ResizeObserver(() => {
          this.ngZone.run(() => this.updateShadows());
        });
        this._resizeObserver.observe(this.el);
      });

      this.destroyRef.onDestroy(() => {
        this._resizeObserver?.disconnect();
      });
    });
  }

  @HostListener('scroll')
  protected onScroll(): void {
    this.updateShadows();
  }

  @HostListener('wheel', ['$event'])
  protected onWheel(event: WheelEvent): void {
    // Standard mouse wheel behavior for horizontal scrolling
    this.el.scrollLeft += event.deltaY;
    event.preventDefault();
    this.updateShadows();
  }

  private updateShadows(): void {
    const { scrollLeft, scrollWidth, clientWidth } = this.el;

    // Threshold of 4px matches the original component logic
    this.leftShadow.emit(scrollLeft > 4);
    this.rightShadow.emit(scrollLeft < scrollWidth - clientWidth - 4);
  }
}
