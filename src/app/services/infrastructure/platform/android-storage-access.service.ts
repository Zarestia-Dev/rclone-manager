import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { fromEvent } from 'rxjs';
import { TauriBaseService } from './tauri-base.service';
import { isAndroid } from './api-client.service';
import { LocalStorageService } from '../../ui/state/local-storage.service';

export interface AndroidNativeStorageBridge {
  isAllFilesAccessGranted?: () => boolean;
  requestAllFilesAccess?: () => void;
}

const STORAGE_PROMPT_DISMISSED_KEY = 'android.storagePromptDismissed';

const getBridge = (): AndroidNativeStorageBridge | undefined =>
  (window as Window & { __rclone__?: AndroidNativeStorageBridge }).__rclone__;

@Injectable({
  providedIn: 'root',
})
export class AndroidStorageAccessService extends TauriBaseService {
  private readonly destroyRef = inject(DestroyRef);
  private readonly localStorage = inject(LocalStorageService);

  private readonly isAllFilesAccessGranted = signal<boolean>(true);
  readonly allFilesAccessGranted = this.isAllFilesAccessGranted.asReadonly();
  private readonly promptDismissed = signal<boolean>(
    this.localStorage.get<boolean>(STORAGE_PROMPT_DISMISSED_KEY, false)
  );

  // Since Android 11, local folders outside the app's own storage need all files access. Asking
  // from a banner replaces opening the system settings on every start until it is granted.
  readonly showAllFilesAccessPrompt = computed(
    () => !this.isAllFilesAccessGranted() && !this.promptDismissed()
  );

  private initialized = false;

  initialize(): void {
    if (!this.isTauri || !isAndroid() || this.initialized) {
      return;
    }
    this.initialized = true;

    this.refreshAllFilesAccess();

    // The settings screen leaves the app, so the answer is only known once it is shown again.
    fromEvent(document, 'visibilitychange')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (!document.hidden) {
          this.refreshAllFilesAccess();
        }
      });
  }

  refreshAllFilesAccess(): void {
    const bridge = getBridge();
    if (!bridge?.isAllFilesAccessGranted) return;
    try {
      this.isAllFilesAccessGranted.set(bridge.isAllFilesAccessGranted());
    } catch (err) {
      console.error('[AndroidStorageAccessService] Failed to check all files access:', err);
    }
  }

  requestAllFilesAccess(): void {
    try {
      getBridge()?.requestAllFilesAccess?.();
    } catch (err) {
      console.error('[AndroidStorageAccessService] Failed to request all files access:', err);
    }
  }

  dismissAllFilesAccessPrompt(): void {
    this.promptDismissed.set(true);
    this.localStorage.set(STORAGE_PROMPT_DISMISSED_KEY, true);
  }
}
