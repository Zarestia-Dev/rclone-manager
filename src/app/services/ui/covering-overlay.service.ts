import { DOCUMENT, inject, Injectable } from '@angular/core';
import { OverlayRef } from '@angular/cdk/overlay';

interface Cover {
  overlayRef: OverlayRef;
  returnFocus: HTMLElement | null;
}

/**
 * Full-window overlays (the main UI, Flow and the file browser as workspaces, and the file
 * picker) hide everything behind them. While one is open, that content is made `inert`, so
 * keyboard focus and screen readers cannot wander into it, and focus moves into the overlay.
 * Closing the top overlay returns focus to where it was.
 *
 * Overlays can stack (the picker over a dialog, a new workspace before the old one closes),
 * so only the top one stays interactive, along with anything opened after it.
 */
@Injectable({ providedIn: 'root' })
export class CoveringOverlayService {
  private readonly document = inject(DOCUMENT);
  private readonly covers: Cover[] = [];
  private inertElements: Element[] = [];

  cover(overlayRef: OverlayRef, host: HTMLElement): void {
    if (this.covers.some(cover => cover.overlayRef === overlayRef)) return;
    const active = this.document.activeElement;
    this.covers.push({
      overlayRef,
      returnFocus: active instanceof HTMLElement && active !== this.document.body ? active : null,
    });
    this.update();
    if (host.contains(this.document.activeElement)) return;
    if (!host.hasAttribute('tabindex')) {
      host.tabIndex = -1;
      host.style.outline = 'none';
    }
    host.focus({ preventScroll: true });
  }

  uncover(overlayRef: OverlayRef): void {
    const index = this.covers.findIndex(cover => cover.overlayRef === overlayRef);
    if (index < 0) return;
    const wasTop = index === this.covers.length - 1;
    const [{ returnFocus }] = this.covers.splice(index, 1);
    // A newer overlay that took focus from this one returns it where this one would have.
    const above = this.covers[index];
    if (above?.returnFocus && overlayRef.hostElement.contains(above.returnFocus)) {
      above.returnFocus = returnFocus;
    }
    const active = this.document.activeElement;
    const focusWasInside =
      !active || active === this.document.body || overlayRef.hostElement.contains(active);
    this.update();
    if (wasTop && focusWasInside && returnFocus?.isConnected && !returnFocus.closest('[inert]')) {
      returnFocus.focus({ preventScroll: true });
    }
  }

  private update(): void {
    for (const element of this.inertElements) element.removeAttribute('inert');
    this.inertElements = [];
    const top = this.covers.at(-1);
    if (!top) return;

    const wrapper = top.overlayRef.hostElement;
    const container = wrapper.parentElement;
    const behind = Array.from(this.document.body.children).filter(
      element => !container || !element.contains(container)
    );
    if (container) {
      for (const element of Array.from(container.children)) {
        if (element === wrapper) break;
        behind.push(element);
      }
    }
    for (const element of behind) {
      // Keep live regions, such as the CDK announcer, so announcements still reach screen readers.
      if (element.hasAttribute('inert') || element.hasAttribute('aria-live')) continue;
      element.setAttribute('inert', '');
      this.inertElements.push(element);
    }
  }
}
