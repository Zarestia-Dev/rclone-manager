import { Directive, ElementRef, inject, AfterViewInit, OnDestroy } from '@angular/core';

@Directive({
  selector: '[appCdkOverlayAutopos]',
  standalone: true,
})
export class CdkOverlayAutoposDirective implements AfterViewInit, OnDestroy {
  private readonly el = inject(ElementRef<HTMLElement>);
  private resizeObserver?: ResizeObserver;

  ngAfterViewInit(): void {
    const node = this.el.nativeElement;
    this.resizeObserver = new ResizeObserver(() => {
      window.dispatchEvent(new Event('resize'));
    });
    this.resizeObserver.observe(node);
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
  }
}
