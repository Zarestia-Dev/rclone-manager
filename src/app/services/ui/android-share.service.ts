import { inject, Injectable, signal } from '@angular/core';
import { NautilusService } from './nautilus.service';
import { isMobile } from '../infrastructure/platform/api-client.service';

interface AndroidNativeBridge {
  getPendingSharedFiles?: () => string;
  getPendingRoute?: () => string;
  clearSharedFiles?: () => void;
  notifyFrontendReady?: () => void;
}

const getBridge = (): AndroidNativeBridge | undefined =>
  (window as Window & { __rclone__?: AndroidNativeBridge }).__rclone__;

/**
 * Handles the Android "Share" intent flow:
 *
 * When another app (Gallery, Files, etc.) shares files into RClone Manager,
 * the Kotlin side either queues the files (cold start) or dispatches an
 * `android-share-files` CustomEvent (warm start). This service:
 *   1. Stores the pending paths in a signal.
 *   2. Opens the Nautilus file browser so the user can navigate to the
 *      destination remote/folder.
 *   3. The NautilusComponent reads `pendingSharedPaths` and shows a
 *      confirmation banner; once the user confirms, upload starts.
 */
@Injectable({ providedIn: 'root' })
export class AndroidShareService {
  private readonly nautilusService = inject(NautilusService);

  /** Absolute local paths of files shared into the app from other apps. */
  readonly pendingSharedPaths = signal<string[]>([]);

  private initialized = false;

  /** Call once from AppComponent to start listening for share events. */
  initialize(): void {
    if (!isMobile() || this.initialized) return;
    this.initialized = true;

    window.addEventListener('android-share-files', (event: Event) => {
      const detail = (event as CustomEvent<{ paths: string[] }>).detail;
      if (!detail?.paths?.length) return;

      this.pendingSharedPaths.set(detail.paths);

      // Open Nautilus so the user can pick the destination remote/folder.
      // newNautilusWindow() falls back to openBrowserOverlay() on mobile.
      void this.nautilusService.newNautilusWindow(null, null);
    });

    window.addEventListener('android-navigate-route', (event: Event) => {
      const detail = (event as CustomEvent<{ route: string }>).detail;
      if (detail?.route === 'nautilus') {
        void this.nautilusService.newNautilusWindow(null, null);
      }
    });

    // Check for pending cold start share files or route queued in Kotlin
    this.checkPendingColdStart();
  }

  /** Called when the user confirms the upload destination. Clears the queue. */
  consumePendingPaths(): string[] {
    const paths = this.pendingSharedPaths();
    this.pendingSharedPaths.set([]);
    return paths;
  }

  /** Discard the pending share without uploading and clean up cached files. */
  cancelPendingShare(): void {
    this.pendingSharedPaths.set([]);
    getBridge()?.clearSharedFiles?.();
  }

  private checkPendingColdStart(): void {
    const bridge = getBridge();
    if (!bridge) return;

    // Pull any shared files queued during cold start
    if (bridge.getPendingSharedFiles) {
      try {
        const raw = bridge.getPendingSharedFiles();
        if (raw && raw !== '[]') {
          const paths = JSON.parse(raw) as string[];
          if (Array.isArray(paths) && paths.length > 0) {
            this.pendingSharedPaths.set(paths);
            void this.nautilusService.newNautilusWindow(null, null);
          }
        }
      } catch (err) {
        console.error('[AndroidShareService] Failed to parse pending shared files:', err);
      }
    }

    // Pull any route intent queued during cold start (e.g. App Shortcut)
    if (bridge.getPendingRoute) {
      try {
        const route = bridge.getPendingRoute();
        if (route === 'nautilus') {
          void this.nautilusService.newNautilusWindow(null, null);
        }
      } catch (err) {
        console.error('[AndroidShareService] Failed to read pending route:', err);
      }
    }

    // Signal to Kotlin that frontend listeners are mounted
    bridge.notifyFrontendReady?.();
  }
}
