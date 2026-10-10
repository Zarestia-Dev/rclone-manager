import { Directive, HostListener, inject } from '@angular/core';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';

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
 * Only closes the dialog if it is the top-most active dialog in the MatDialog stack.
 */
@Directive({
  selector: '[appEscapeClose]',
})
export class EscapeCloseDirective {
  private readonly dialogRef = inject(MatDialogRef<unknown>, { optional: true });
  private readonly dialog = inject(MatDialog, { optional: true });

  @HostListener('document:keydown.escape')
  close(): void {
    if (!this.dialogRef) return;
    if (this.dialog && this.dialog.openDialogs.length > 0) {
      const topDialog = this.dialog.openDialogs[this.dialog.openDialogs.length - 1];
      if (topDialog !== this.dialogRef) {
        return;
      }
    }
    this.dialogRef.close();
  }
}
