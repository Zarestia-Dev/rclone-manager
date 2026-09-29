import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { NautilusService } from './nautilus.service';
import { isMobile } from '../infrastructure/platform/api-client.service';

interface AndroidNativeBridge {
  getPendingSharedFiles?: () => string;
  getPendingRoute?: () => string;
  clearSharedFiles?: (paths: string) => void;
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
  private readonly destroyRef = inject(DestroyRef);
  private readonly nautilusService = inject(NautilusService);

  /** Absolute local paths of files shared into the app from other apps. */
  readonly pendingSharedPaths = signal<string[]>([]);

  readonly uploading = signal(false);

  private initialized = false;
  private activePaths = new Set<string>();

  /** Call once from AppComponent to start listening for share events. */
  initialize(): void {
    if (!isMobile() || this.initialized) return;
    this.initialized = true;

    const onShare = (event: Event): void => {
      const detail = (event as CustomEvent<{ paths: string[] }>).detail;
      const received = this.addPendingPaths(detail?.paths);
      const pending = this.readPendingFiles();
      if (!received && !pending) return;

      // Open Nautilus so the user can pick the destination remote/folder.
      // newNautilusWindow() falls back to openBrowserOverlay() on mobile.
      void this.nautilusService.newNautilusWindow(null, null);
    };

    const onNavigate = (event: Event): void => {
      const detail = (event as CustomEvent<{ route: string }>).detail;
      if (detail?.route === 'nautilus') {
        void this.nautilusService.newNautilusWindow(null, null);
      }
    };
    window.addEventListener('android-share-files', onShare);
    window.addEventListener('android-navigate-route', onNavigate);
    this.destroyRef.onDestroy(() => {
      window.removeEventListener('android-share-files', onShare);
      window.removeEventListener('android-navigate-route', onNavigate);
    });

    // Check for pending cold start share files or route queued in Kotlin
    this.checkPendingColdStart();
  }

  async uploadPending(upload: (paths: string[]) => Promise<boolean>): Promise<boolean> {
    if (this.uploading() || !this.pendingSharedPaths().length) return false;
    const paths = this.pendingSharedPaths();
    this.pendingSharedPaths.set([]);
    this.activePaths = new Set(paths);
    this.uploading.set(true);
    let success = false;
    try {
      success = await upload(paths);
      if (success) this.clearCachedPaths(paths);
      return success;
    } finally {
      this.activePaths.clear();
      if (!success) this.addPendingPaths(paths);
      this.uploading.set(false);
    }
  }

  /** Discard only the pending files, leaving active uploads intact. */
  cancelPendingShare(): void {
    const paths = this.pendingSharedPaths();
    this.pendingSharedPaths.set([]);
    this.clearCachedPaths(paths);
  }

  private clearCachedPaths(paths: string[]): void {
    if (!paths.length) return;
    try {
      getBridge()?.clearSharedFiles?.(JSON.stringify(paths));
    } catch (error) {
      console.error('[AndroidShareService] Failed to clean shared files:', error);
    }
  }

  private addPendingPaths(value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    const paths = value.filter(
      (path): path is string => typeof path === 'string' && !!path && !this.activePaths.has(path)
    );
    if (!paths.length) return false;
    this.pendingSharedPaths.update(pending => [...new Set([...pending, ...paths])]);
    return true;
  }

  private readPendingFiles(): boolean {
    try {
      const raw = getBridge()?.getPendingSharedFiles?.();
      return raw ? this.addPendingPaths(JSON.parse(raw)) : false;
    } catch (error) {
      console.error('[AndroidShareService] Failed to parse pending shared files:', error);
      return false;
    }
  }

  private checkPendingColdStart(): void {
    const bridge = getBridge();
    if (!bridge) return;

    if (this.readPendingFiles()) {
      void this.nautilusService.newNautilusWindow(null, null);
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
