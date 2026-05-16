import { Directive, HostListener, input, inject, HostBinding } from '@angular/core';
import { Clipboard } from '@angular/cdk/clipboard';
import { TranslateService } from '@ngx-translate/core';
import { NotificationService } from '@app/services';

/**
 * Directive to add "Copy to Clipboard" behavior to any element.
 * Self-contained: handles copying and user feedback.
 *
 * Usage:
 * <button [appCopyToClipboard]="textToCopy">Copy</button>
 */
@Directive({
  selector: '[appCopyToClipboard]',
  standalone: true,
})
export class CopyToClipboardDirective {
  private readonly clipboard = inject(Clipboard);
  private readonly translate = inject(TranslateService);
  private readonly notificationService = inject(NotificationService);

  /** The text to be copied to the clipboard */
  copyText = input.required<string | null | undefined>({ alias: 'appCopyToClipboard' });

  /** Optional: whether to show the snackbar notification (default: true) */
  showNotification = input<boolean>(true);

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

    event.stopPropagation();
    event.preventDefault();

    const success = this.clipboard.copy(text);

    if (this.showNotification()) {
      if (success) {
        this.notificationService.showSuccess(this.translate.instant('common.copied'));
      } else {
        this.notificationService.showError(this.translate.instant('common.copyFailed'));
      }
    }
  }
}
