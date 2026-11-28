import { afterNextRender, DestroyRef, Directive, ElementRef, inject, input } from '@angular/core';

/** Inherited properties the header gives its content, copied to the controls outside it. */
const INHERITED = [
  'color',
  'cursor',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'letter-spacing',
  'line-height',
  'text-transform',
] as const;

/**
 * Draws controls over an expansion panel header without putting them inside it.
 *
 * A panel header is a button, and a button can't contain other controls: screen readers flatten
 * them into the header's name and can't reach them, and their keys also toggle the panel. So the
 * controls are written once as a template and rendered twice:
 *
 *   <ng-template #actions>...buttons or a toggle...</ng-template>
 *   <mat-expansion-panel>
 *     <mat-expansion-panel-header>
 *       ...
 *       <span class="header-controls-slot" data-header-controls-slot="actions" aria-hidden="true" inert>
 *         <ng-container [ngTemplateOutlet]="actions" />
 *       </span>
 *     </mat-expansion-panel-header>
 *     <span appHeaderControls="actions" ngProjectAs="mat-expansion-panel-header">
 *       <ng-container [ngTemplateOutlet]="actions" />
 *     </span>
 *     ...
 *   </mat-expansion-panel>
 *
 * The copy in the header (the slot) is invisible and inert: it only keeps the header's layout as
 * it was. The real controls are the header's sibling (ngProjectAs puts them next to it, not in the
 * panel's collapsible body), and this directive keeps them exactly over the slot as the header
 * resizes, wraps or changes its content. It also gives them the text style they would inherit
 * inside the header (a bold title, a disabled panel's grey), so they look as they did there.
 */
@Directive({
  selector: '[appHeaderControls]',
  host: { class: 'header-controls' },
})
export class HeaderControlsDirective {
  /** The name of the slot (its data-header-controls-slot) in this panel's header. */
  readonly appHeaderControls = input.required<string>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private frame = 0;
  private resize?: ResizeObserver;

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const header = this.host.parentElement?.querySelector(':scope > mat-expansion-panel-header');
      const schedule = (): void => {
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(() => this.place());
      };
      if (!header) return;

      this.resize = new ResizeObserver(schedule);
      this.resize.observe(header);
      // Content that changes without resizing the header (a status text, a class that starts a
      // transition) can still move or resize the slot.
      const mutation = new MutationObserver(schedule);
      mutation.observe(header, {
        attributes: true,
        childList: true,
        subtree: true,
        characterData: true,
      });
      header.addEventListener('transitionend', schedule);
      this.place();

      destroyRef.onDestroy(() => {
        cancelAnimationFrame(this.frame);
        this.resize?.disconnect();
        mutation.disconnect();
        header.removeEventListener('transitionend', schedule);
      });
    });
  }

  private slot(): HTMLElement | null {
    const name = CSS.escape(this.appHeaderControls());
    return (
      this.host.parentElement?.querySelector<HTMLElement>(
        `:scope > mat-expansion-panel-header [data-header-controls-slot="${name}"]`
      ) ?? null
    );
  }

  /** Moves and sizes the controls to the slot's box. */
  private place(): void {
    const slot = this.slot();
    const container = this.host.offsetParent;
    if (!slot || !container) return;
    this.resize?.observe(slot);
    // Offsets, not client rects: they are in the same CSS pixels as the styles set here, whatever
    // the interface scale or a transform on an ancestor.
    let left = 0;
    let top = 0;
    let el: Element | null = slot;
    while (el instanceof HTMLElement && el !== container) {
      left += el.offsetLeft;
      top += el.offsetTop;
      el = el.offsetParent;
      // Each offset is from the next parent's padding edge: add that parent's border, except the
      // container's, whose padding edge is where the controls' own offsets start.
      if (el instanceof HTMLElement && el !== container) {
        left += el.clientLeft;
        top += el.clientTop;
      }
    }
    if (el !== container) return;
    const style = this.host.style;
    style.left = `${left}px`;
    style.top = `${top}px`;
    style.width = `${slot.offsetWidth}px`;
    style.height = `${slot.offsetHeight}px`;
    // Offsets are rounded to whole pixels, which moves text by a fraction of one. Client rects
    // keep the fraction: add the difference, scaled back to CSS pixels.
    const slotRect = slot.getBoundingClientRect();
    const hostRect = this.host.getBoundingClientRect();
    const scale = this.host.offsetWidth ? hostRect.width / this.host.offsetWidth : 1;
    if (scale > 0 && Number.isFinite(scale)) {
      style.left = `${left + (slotRect.left - hostRect.left) / scale}px`;
      style.top = `${top + (slotRect.top - hostRect.top) / scale}px`;
      style.width = `${slotRect.width / scale}px`;
      style.height = `${slotRect.height / scale}px`;
    }
    const inherited = getComputedStyle(slot);
    for (const property of INHERITED) {
      style.setProperty(property, inherited.getPropertyValue(property));
    }
  }
}
