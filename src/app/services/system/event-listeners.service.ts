import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { fromEvent } from 'rxjs';
import { TauriBaseService } from '../core/tauri-base.service';
import {
  AppEventPayloadType,
  ENGINE_RESTARTED,
  MOUNT_STATE_CHANGED,
  REMOTE_CACHE_CHANGED,
  JOB_CACHE_CHANGED,
  MOUNT_PLUGIN_INSTALLED,
  APP_EVENT,
  NETWORK_STATUS_CHANGED,
  BANDWIDTH_LIMIT_CHANGED,
  SERVE_STATE_CHANGED,
  RCLONE_ENGINE_READY,
  RCLONE_ENGINE_ERROR,
  RCLONE_ENGINE_PASSWORD_ERROR,
  RCLONE_ENGINE_PATH_ERROR,
  RCLONE_ENGINE_UPDATING,
  RCLONE_PASSWORD_STORED,
  OPEN_INTERNAL_ROUTE,
} from '@app/types';
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
    // In the web/headless mode Tauri window events don't exist, so fall back to
    // native window resize events when not running as Tauri runtime.
    if (!this.isTauriEnvironment) {
      return fromEvent(window, 'resize');
    }

    return this.listenToEvent<unknown>('tauri://resize');
  }

  /**
   * Listen to engine restarted events
   */
  listenToEngineRestarted(): Observable<{ reason: string }> {
    return this.listenToEvent<{ reason: string }>(ENGINE_RESTARTED);
  }
  /**
   * Listen to mount cache updated events
   */
  listenToMountCacheUpdated(): Observable<unknown> {
    return this.listenToEvent<unknown>(MOUNT_STATE_CHANGED);
  }

  /**
   * Listen to remote cache updated events
   */
  listenToRemoteCacheUpdated(): Observable<unknown> {
    return this.listenToEvent<unknown>(REMOTE_CACHE_CHANGED);
  }

  /**
   * Listen to serve state changed events
   */
  listenToServeStateChanged(): Observable<unknown> {
    return this.listenToEvent<unknown>(SERVE_STATE_CHANGED);
  }

  /**
   * Listen to job cache changed events
   */
  listenToJobCacheChanged(): Observable<unknown> {
    return this.listenToEvent<unknown>(JOB_CACHE_CHANGED);
  }
  /**
   * Listen to mount plugin installation events
   */
  listenToMountPluginInstalled(): Observable<unknown> {
    return this.listenToEvent<unknown>(MOUNT_PLUGIN_INSTALLED);
  }

  /**
   * Listen to rclone engine ready events
   */
  listenToRcloneEngineReady(): Observable<void> {
    return this.listenToEvent<void>(RCLONE_ENGINE_READY);
  }

  /**
   * Listen to rclone engine error events
   */
  listenToRcloneEngineError(): Observable<void> {
    return this.listenToEvent<void>(RCLONE_ENGINE_ERROR);
  }

  /**
   * Listen to rclone engine password error events
   */
  listenToRcloneEnginePasswordError(): Observable<void> {
    return this.listenToEvent<void>(RCLONE_ENGINE_PASSWORD_ERROR);
  }

  /**
   * Listen to rclone engine path error events
   */
  listenToRcloneEnginePathError(): Observable<void> {
    return this.listenToEvent<void>(RCLONE_ENGINE_PATH_ERROR);
  }

  /**
   * Listen to rclone engine updating events
   */
  listenToRcloneEngineUpdating(): Observable<void> {
    return this.listenToEvent<void>(RCLONE_ENGINE_UPDATING);
  }

  /**
   * Listen to rclone password stored events
   */
  listenToRclonePasswordStored(): Observable<void> {
    return this.listenToEvent<void>(RCLONE_PASSWORD_STORED);
  }

  /**
   * Listen to app events
   */
  listenToAppEvents(): Observable<AppEventPayloadType> {
    return this.listenToEvent<AppEventPayloadType>(APP_EVENT);
  }

  /**
   * Listen to network status changed events
   */
  listenToNetworkStatusChanged(): Observable<{ isMetered: boolean }> {
    return this.listenToEvent<{ isMetered: boolean }>(NETWORK_STATUS_CHANGED);
  }

  /**
   * Listen to bandwidth limit changed events
   */
  listenToBandwidthLimitChanged(): Observable<unknown> {
    return this.listenToEvent<unknown>(BANDWIDTH_LIMIT_CHANGED);
  }

  /**
   * Listen to open internal route events from tray menu
   */
  listenToOpenInternalRoute(): Observable<string> {
    return this.listenToEvent<string>(OPEN_INTERNAL_ROUTE);
  }
}
