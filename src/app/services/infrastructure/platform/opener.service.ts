import { Injectable } from '@angular/core';
import { isHeadlessMode } from './api-client.service';
import { openUrl, openPath } from '@tauri-apps/plugin-opener';

@Injectable({ providedIn: 'root' })
export class OpenerService {
  private readonly isTauri = !isHeadlessMode();
  private interceptorInitialized = false;

  /**
   * Opens an external web URL using the system's default browser on Desktop (Tauri),
   * or a new tab/window in Web/Headless mode.
   */
  async openUrl(url: string): Promise<void> {
    if (!url) return;

    if (this.isTauri) {
      try {
        await openUrl(url);
        return;
      } catch (err) {
        console.warn('Failed to open URL via plugin-opener, falling back to window.open:', err);
      }
    }

    window.open(url, '_blank', 'noopener,noreferrer');
  }

  /**
   * Opens a file or folder in the OS default file manager or default application.
   */
  async openPath(path: string): Promise<void> {
    if (!path) return;

    if (this.isTauri) {
      try {
        await openPath(path);
      } catch (err) {
        console.error('Failed to open path via plugin-opener:', err);
      }
    }
  }

  /**
   * Intercepts all clicks on `<a>` tags with external protocols (http, https, mailto)
   * on Desktop so they reliably open in the default browser without webview navigation issues.
   */
  initializeGlobalLinkInterceptor(): void {
    if (!this.isTauri || this.interceptorInitialized) return;
    this.interceptorInitialized = true;

    document.addEventListener(
      'click',
      (event: MouseEvent) => {
        const target = event.target as HTMLElement | null;
        const anchor = target?.closest('a') as HTMLAnchorElement | null;
        if (!anchor || !anchor.href) return;

        const href = anchor.href;
        if (/^(https?:\/\/|mailto:)/i.test(href)) {
          event.preventDefault();
          event.stopPropagation();
          void this.openUrl(href);
        }
      },
      true
    );
  }
}
