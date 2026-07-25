import { inject, Injectable, signal } from '@angular/core';
import { NautilusService } from './nautilus.service';
import { isMobile } from '../infrastructure/platform/api-client.service';

/**
 * Handles the Android "Share" intent flow:
 *
 * When another app (Gallery, Files, etc.) shares files into Rclone Manager,
 * the Kotlin side dispatches an `android-share-files` CustomEvent with the
 * resolved local paths. This service:
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

  /** Call once from AppComponent to start listening for share events. */
  initialize(): void {
    if (!isMobile()) return;

    window.addEventListener('android-share-files', (event: Event) => {
      const detail = (event as CustomEvent<{ paths: string[] }>).detail;
      if (!detail?.paths?.length) return;

      this.pendingSharedPaths.set(detail.paths);

      // Open Nautilus so the user can pick the destination remote/folder.
      // newNautilusWindow() falls back to openBrowserOverlay() on mobile.
      void this.nautilusService.newNautilusWindow(null, null);
    });
  }

  /** Called when the user confirms the upload destination. Clears the queue. */
  consumePendingPaths(): string[] {
    const paths = this.pendingSharedPaths();
    this.pendingSharedPaths.set([]);
    return paths;
  }

  /** Discard the pending share without uploading. */
  cancelPendingShare(): void {
    this.pendingSharedPaths.set([]);
  }
}
