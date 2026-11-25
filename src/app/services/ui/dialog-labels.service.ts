import { afterNextRender, DestroyRef, inject, Injectable, Injector } from '@angular/core';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';

/** The title of a modal: a paragraph or heading directly inside its header. */
const TITLE_SELECTOR = ':is(p, h1, h2, h3)';

/**
 * Names every dialog after the title in its header, so screen readers announce what opened.
 * Modals put their title in `<header><p>…</p></header>` instead of using `mat-dialog-title`
 * (which would also restyle it), so this links the title to the dialog the way that directive
 * does; a dialog without a header is named by its first heading. A dialog opened with an
 * `ariaLabel` keeps it: use one when the header shows no title (Preferences shows its tabs).
 */
@Injectable({ providedIn: 'root' })
export class DialogLabelsService {
  private readonly dialog = inject(MatDialog);
  private readonly injector = inject(Injector);

  constructor() {
    const subscription = this.dialog.afterOpened.subscribe(ref => {
      // Label once the content has rendered; a title that only appears later (after data loads)
      // is picked up when the open animation ends.
      afterNextRender(() => labelDialog(ref), { injector: this.injector });
      ref.afterOpened().subscribe(() => labelDialog(ref));
    });
    inject(DestroyRef).onDestroy(() => subscription.unsubscribe());
  }
}

/** Points the dialog's aria-labelledby at its header title. Exported for tests. */
export function labelDialog(ref: MatDialogRef<unknown>): void {
  const container = ref._containerInstance;
  if (!container || container._config.ariaLabel) return;
  const host = document.getElementById(ref.id);
  // The header's title, or else the first h1 or h2 (the confirm dialog has no header).
  const title =
    host?.querySelector('header')?.querySelector<HTMLElement>(`:scope > ${TITLE_SELECTOR}`) ??
    host?.querySelector<HTMLElement>('h1, h2');
  if (!title?.textContent?.trim()) return;
  title.id ||= `${ref.id}-title`;
  if (!container._ariaLabelledByQueue.includes(title.id)) container._addAriaLabelledBy(title.id);
}
