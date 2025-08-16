import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { TauriBaseService } from '../core/tauri-base.service';

export interface RcloneEngineEvent {
  status: string;
  port?: number;
  timestamp?: string;
  message?: string;
}

export interface UpdateResult {
  success: boolean;
  message?: string;
}

// Union type to handle both old string format and new object format
export type RcloneEnginePayload = RcloneEngineEvent | string;

/**
 * Service for handling installations of rclone and plugins
 * Manages the provisioning and setup of required components
 */
@Injectable({
  providedIn: 'root',
})
export class EventListenersService extends TauriBaseService {
  /**
   * Listen to tauri window resize events
   */
  listenToWindowResize(): Observable<unknown> {
    return this.listenToEvent<unknown>('tauri://resize');
  }

  /**
   * Listen to remote deleted events
   */
  listenToRemoteDeleted(): Observable<{ payload: string }> {
    return this.listenToEvent<{ payload: string }>('remote_deleted');
  }

  /**
   * Listen to engine restarted events
   */
  listenToEngineRestarted(): Observable<{ payload: { reason: string } }> {
    return this.listenToEvent<{ payload: { reason: string } }>('engine_restarted');
  }
  /**
   * Listen to mount cache updated events
   */
  listenToMountCacheUpdated(): Observable<unknown> {
    return this.listenToEvent<unknown>('mount_cache_updated');
  }

  /**
   * Listen to remote cache updated events
   */
  listenToRemoteCacheUpdated(): Observable<unknown> {
    return this.listenToEvent<unknown>('remote_cache_updated');
  }

  /**
   * Listen to notify UI events
   */
  listenToNotifyUi(): Observable<{ payload: string }> {
    return this.listenToEvent<{ payload: string }>('notify_ui');
  }

  /**
   * Listen to job cache changed events
   */
  listenToJobCacheChanged(): Observable<unknown> {
    return this.listenToEvent<unknown>('job_cache_changed');
  }
  /**
   * Listen to mount plugin installation events
   */
  listenToMountPluginInstalled(): Observable<unknown> {
    return this.listenToEvent<unknown>('mount_plugin_installed');
  }

  /**
   * Listen to rclone engine events
   */
  listenToRcloneEngine(): Observable<RcloneEnginePayload> {
    return this.listenToEvent<RcloneEnginePayload>('rclone_engine');
  }

  /**
   * Listen to app events
   */
  listenToAppEvents(): Observable<RcloneEnginePayload> {
    return this.listenToEvent<RcloneEnginePayload>('app_event');
  }

  /**
   * Listen to network status changed events
   */
  listenToNetworkStatusChanged(): Observable<{ isMetered: boolean }> {
    return this.listenToEvent<{ isMetered: boolean }>('network-status-changed');
  }

  /**
   * Listen to bandwidth limit changed events
   */
  listenToBandwidthLimitChanged(): Observable<unknown> {
    return this.listenToEvent<unknown>('bandwidth_limit_changed');
  }
}
