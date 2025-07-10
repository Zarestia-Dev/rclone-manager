import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { BehaviorSubject, interval } from 'rxjs';

export interface RcloneUpdateInfo {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  current_version_clean: string;
  latest_version_clean: string;
  release_notes?: string;
  release_date?: string;
  download_url?: string;
}

export interface UpdateStatus {
  checking: boolean;
  updating: boolean;
  available: boolean;
  error: string | null;
  lastCheck: Date | null;
  updateInfo: RcloneUpdateInfo | null;
}

interface TauriEvent<T = unknown> {
  payload: T;
  windowLabel: string;
  event: string;
}

interface UpdateResult {
  success: boolean;
  message?: string;
}

// Declare Tauri API functions
declare global {
  interface Window {
    __TAURI__: {
      tauri: {
        invoke: <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
      };
      event: {
        listen: <T = unknown>(
          event: string,
          handler: (event: TauriEvent<T>) => void
        ) => Promise<void>;
      };
    };
  }
}

@Injectable({
  providedIn: 'root',
})
export class RcloneUpdateService {
  private updateStatusSubject = new BehaviorSubject<UpdateStatus>({
    checking: false,
    updating: false,
    available: false,
    error: null,
    lastCheck: null,
    updateInfo: null,
  });

  public updateStatus$ = this.updateStatusSubject.asObservable();

  constructor() {
    this.setupEventListeners();
    // Check for updates every 6 hours
    interval(6 * 60 * 60 * 1000).subscribe(() => {
      this.checkForUpdates();
    });
  }

  private setupEventListeners(): void {
    if (!window.__TAURI__) return;

    // Listen for engine update events
    listen('engine_update_started', () => {
      this.updateStatus({ updating: true });
    });

    listen<UpdateResult>('engine_update_completed', event => {
      this.updateStatus({
        updating: false,
        available: !event.payload.success, // If update succeeded, no longer available
      });
      if (event.payload.success) {
        this.checkForUpdates(); // Refresh status after successful update
      }
    });

    listen<{ reason: string }>('engine_restarted', event => {
      if (event.payload.reason === 'rclone_update') {
        this.checkForUpdates(); // Check status after restart
      }
    });
  }

  async checkForUpdates(): Promise<RcloneUpdateInfo | null> {
    this.updateStatus({ checking: true, error: null });

    try {
      const updateInfo = await invoke<RcloneUpdateInfo>('check_rclone_update');

      this.updateStatus({
        checking: false,
        available: updateInfo.update_available,
        lastCheck: new Date(),
        updateInfo: updateInfo,
      });

      return updateInfo;
    } catch (error) {
      console.error('Failed to check for updates:', error);
      this.updateStatus({
        checking: false,
        error: error as string,
        lastCheck: new Date(),
      });
      return null;
    }
  }

  async getDetailedUpdateInfo(): Promise<RcloneUpdateInfo> {
    try {
      return await invoke<RcloneUpdateInfo>('get_rclone_update_info');
    } catch (error) {
      console.error('Failed to get detailed update info:', error);
      throw error;
    }
  }

  async performUpdate(): Promise<boolean> {
    this.updateStatus({ updating: true, error: null });

    try {
      const result = await invoke<UpdateResult>('update_rclone');

      if (result.success) {
        this.updateStatus({
          updating: false,
          available: false,
          updateInfo: null,
        });

        // Log the successful update with path info if available
        if ('path' in result) {
          console.log('Rclone updated successfully at:', result.path);
        }

        return true;
      } else {
        this.updateStatus({
          updating: false,
          error: result.message || 'Update failed',
        });
        return false;
      }
    } catch (error) {
      console.error('Failed to update rclone:', error);
      this.updateStatus({
        updating: false,
        error: error as string,
      });
      return false;
    }
  }

  private updateStatus(update: Partial<UpdateStatus>): void {
    const currentStatus = this.updateStatusSubject.value;
    this.updateStatusSubject.next({ ...currentStatus, ...update });
  }

  getCurrentStatus(): UpdateStatus {
    return this.updateStatusSubject.value;
  }
}
