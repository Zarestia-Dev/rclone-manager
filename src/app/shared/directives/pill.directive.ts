import { Directive, computed, input } from '@angular/core';
import type { PillSize, PillTone, PillVariant } from '@app/types';

/**
 * The one way to render a pill, badge or chip.
 *
 * ```html
 * <span appPill>Idle</span>
 * <span appPill tone="accent" size="xs">Workflow</span>
 * <span appPill="solid" tone="primary">Running</span>
 * <button appPill tone="accent" [selected]="isOn()" (click)="toggle()">Daily</button>
 * ```
 *
 * - The attribute value is the emphasis (`tonal` by default, `solid`, `outline`), like `matButton`.
 * - `tone` is the colour role; leave it out for the neutral look.
 * - A `<button>`, `<a>` or `role="button"` pill is interactive, a `<span>` never is.
 * - `[selected]` marks a toggle: it styles the pill and sets `aria-pressed`.
 *
 * Styling lives in the `.app-pill` block of `custom-theme.scss`, driven by the `data-*` attributes
 * set here. Code that builds a pill by hand (no Angular) sets the same class and attributes.
 */
@Directive({
  selector: '[appPill]',
  host: {
    class: 'app-pill',
    '[attr.data-tone]': 'tone() ?? null',
    '[attr.data-variant]': 'variant()',
    '[attr.data-size]': 'size() === "md" ? null : size()',
    '[attr.data-selected]': 'selected() ? "" : null',
    '[attr.aria-pressed]': 'ariaPressed()',
  },
})
export class PillDirective {
  readonly appPill = input<PillVariant | ''>('');
  readonly tone = input<PillTone | null | undefined>(null);
  readonly size = input<PillSize>('md');
  /** Leave unbound for a pill that is not a toggle. */
  readonly selected = input<boolean | undefined>(undefined);

  protected readonly variant = computed(() => this.appPill() || null);
  protected readonly ariaPressed = computed(() => {
    const selected = this.selected();
    return selected === undefined ? null : String(selected);
  });
}
