import { Injectable } from '@angular/core';
import { UpdateResult } from './rclone-update-clean.service';
import { Observable } from 'rxjs';
import { TauriBaseService } from '../core/tauri-base.service';

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
   * Listen to engine update started events
   */
  listenToEngineUpdateStarted(): Observable<unknown> {
    return this.listenToEvent<unknown>('engine_update_started');
  }

  /**
   * Listen to engine update completed events
   */
  listenToEngineUpdateCompleted(): Observable<{ payload: UpdateResult }> {
    return this.listenToEvent<{ payload: UpdateResult }>('engine_update_completed');
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
   * Listen to shutdown sequence events
   */
  listenToShutdownSequence(): Observable<unknown> {
    return this.listenToEvent<unknown>('shutdown_sequence');
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
   * Listen to rclone API ready events
   */
  listenToRcloneApiReady(): Observable<any> {
    return this.listenToEvent<any>('rclone_api_ready');
  }

  /**
   * Listen to rclone engine failure events
   */
  listenToRcloneEngineFailed(): Observable<any> {
    return this.listenToEvent<any>('rclone_engine_failed');
  }

  /**
   * Listen to rclone path invalid events
   */
  listenToRclonePathInvalid(): Observable<any> {
    return this.listenToEvent<any>('rclone_path_invalid');
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
  listenToBandwidthLimitChanged(): Observable<any> {
    return this.listenToEvent<any>('bandwidth_limit_changed');
  }
}
