import { Directive, HostListener, inject } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';

/**
 * Closes the host MatDialog when the user presses Escape anywhere in the document.
 *
 * Replaces the boilerplate `@HostListener('document:keydown.escape') close() { this.dialogRef.close(); }`
 * pattern that was duplicated across 10+ modal components.
 *
 * Usage in a modal template's root element:
 *   <div appEscapeClose> ... </div>
 *
 * Or as a host directive on the component:
 *   @Component({ hostDirectives: [EscapeCloseDirective] })
 *
 * The directive is a no-op when not inside a MatDialog (the `MatDialogRef` injection is optional).
 * Modals that need custom Escape logic (conditional close, extra cleanup, returning a specific
 * result) should NOT use this directive — keep their explicit `@HostListener` instead.
 */
@Directive({
  selector: '[appEscapeClose]',
})
export class EscapeCloseDirective {
  private readonly dialogRef = inject(MatDialogRef<unknown>, { optional: true });

  @HostListener('document:keydown.escape')
  close(): void {
    if (this.dialogRef) {
      this.dialogRef.close();
    }
  }
}
