import { Injectable, OnDestroy } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';
import { EventListenersService } from './event-listeners.service';
import { inject } from '@angular/core';
import { BehaviorSubject, interval, Subject, takeUntil } from 'rxjs';

import { RcloneUpdateInfo, UpdateStatus, UpdateResult } from '@app/types';

@Injectable({
  providedIn: 'root',
})
export class RcloneUpdateService extends TauriBaseService implements OnDestroy {
  private updateStatusSubject = new BehaviorSubject<UpdateStatus>({
    checking: false,
    updating: false,
    available: false,
    error: null,
    lastCheck: null,
    updateInfo: null,
  });

  private destroy$ = new Subject<void>();

  public updateStatus$ = this.updateStatusSubject.asObservable();

  private eventListenersService = inject(EventListenersService);

  constructor() {
    super();
    this.setupEventListeners();
    // Check for updates every 6 hours
    interval(6 * 60 * 60 * 1000).subscribe(() => {
      this.checkForUpdates();
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private setupEventListeners(): void {
    // Listen for engine update started
    this.eventListenersService
      .listenToRcloneEngine()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: async event => {
          try {
            console.log('Rclone Engine event payload:', event);

            if (typeof event === 'object' && event?.status === 'updating') {
              this.updateStatus({ updating: true });
            } else if (typeof event === 'object' && event?.status === 'updated') {
              this.updateStatus({ updating: false });
              this.checkForUpdates();
            }
          } catch (error) {
            console.error('Error handling Rclone Engine event:', error);
          }
        },
      });

    // Listen for engine restarted
    this.eventListenersService.listenToEngineRestarted().subscribe(event => {
      if (event.payload.reason === 'rclone_update') {
        this.checkForUpdates();
      }
    });
  }

  async checkForUpdates(): Promise<RcloneUpdateInfo | null> {
    this.updateStatus({ checking: true, error: null });

    try {
      const updateInfo = await this.invokeCommand<RcloneUpdateInfo>('check_rclone_update');

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
      return await this.invokeCommand<RcloneUpdateInfo>('get_rclone_update_info');
    } catch (error) {
      console.error('Failed to get detailed update info:', error);
      throw error;
    }
  }

  async performUpdate(): Promise<boolean> {
    this.updateStatus({ updating: true, error: null });

    try {
      const result = await this.invokeCommand<UpdateResult>('update_rclone');

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
