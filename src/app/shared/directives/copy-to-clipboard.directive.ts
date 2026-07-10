import {
  Directive,
  HostListener,
  input,
  inject,
  HostBinding,
  ElementRef,
  output,
} from '@angular/core';
import { Clipboard } from '@angular/cdk/clipboard';
import { TranslateService } from '@ngx-translate/core';
import { NotificationService } from 'src/app/services/ui/notification.service';

/**
 * Copy-to-clipboard behavior for any element.
 *
 * Usage: `<button [appCopyToClipboard]="textToCopy">Copy</button>`
 *
 * Self-contained: handles copying and user feedback (snackbar).
 * Skips copying when the user has manually selected text inside the host element.
 */
@Directive({
  selector: '[appCopyToClipboard]',
})
export class CopyToClipboardDirective {
  private readonly clipboard = inject(Clipboard);
  private readonly translate = inject(TranslateService);
  private readonly notificationService = inject(NotificationService);
  private readonly elementRef = inject(ElementRef);

  /** The text to be copied to the clipboard. */
  copyText = input.required<string | null | undefined>({ alias: 'appCopyToClipboard' });

  /** Whether to show the snackbar notification (default: true). */
  showNotification = input<boolean>(true);

  /** Emits true on success, false on failure. */
  readonly copied = output<boolean>();

  @HostBinding('style.cursor')
  get cursor(): string {
    return this.copyText() ? 'pointer' : 'default';
  }

  @HostListener('click', ['$event'])
  onClick(event: MouseEvent): void {
    this.performCopy(event);
  }

  @HostListener('keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      this.performCopy(event);
    }
  }

  private performCopy(event: Event): void {
    const text = this.copyText();
    if (!text) return;

    // Do not overwrite copy if user has manually selected some text inside the host element
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
      const hostElement = this.elementRef.nativeElement;
      const anchorInside = selection.anchorNode && hostElement.contains(selection.anchorNode);
      const focusInside = selection.focusNode && hostElement.contains(selection.focusNode);
      if (anchorInside || focusInside) {
        return;
      }
    }

    event.stopPropagation();
    event.preventDefault();

    const success = this.clipboard.copy(text);

    this.copied.emit(success);

    if (this.showNotification()) {
      if (success) {
        this.notificationService.showSuccess(this.translate.instant('common.copied'));
      } else {
        this.notificationService.showError(this.translate.instant('common.copyFailed'));
      }
    }
  }
}
