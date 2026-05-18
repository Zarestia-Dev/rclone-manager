import { Injectable } from '@angular/core';
import { Observable, fromEvent } from 'rxjs';
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
  SYSTEM_STATUS,
  RCLONE_ENGINE_READY,
  RCLONE_ENGINE_ERROR,
  RCLONE_ENGINE_PASSWORD_ERROR,
  RCLONE_ENGINE_PATH_ERROR,
  RCLONE_ENGINE_UPDATING,
  RCLONE_PASSWORD_STORED,
  BROWSE,
  SYSTEM_SETTINGS_CHANGED,
  SCHEDULED_TASKS_CACHE_CHANGED,
  REMOTE_SETTINGS_CHANGED,
  SettingsChangeEvent,
  RCLONE_OAUTH_URL,
  OAuthUrlEvent,
  JobChangeEvent,
  SystemStatusPayload,
} from '@app/types';
import { TauriBaseService } from '../platform/tauri-base.service';

@Injectable({ providedIn: 'root' })
export class EventListenersService extends TauriBaseService {
  listenToWindowResize(): Observable<unknown> {
    if (!this.isTauri) {
      return fromEvent(window, 'resize');
    }
    return this.listenToEvent<unknown>('tauri://resize');
  }

  listenToEngineRestarted(): Observable<{ reason: string }> {
    return this.listenToEvent<{ reason: string }>(ENGINE_RESTARTED);
  }

  listenToMountCacheUpdated(): Observable<unknown> {
    return this.listenToEvent<unknown>(MOUNT_STATE_CHANGED);
  }

  listenToRemoteCacheUpdated(): Observable<unknown> {
    return this.listenToEvent<unknown>(REMOTE_CACHE_CHANGED);
  }

  listenToServeStateChanged(): Observable<unknown> {
    return this.listenToEvent<unknown>(SERVE_STATE_CHANGED);
  }

  listenToJobCacheChanged(): Observable<JobChangeEvent> {
    return this.listenToEvent<JobChangeEvent>(JOB_CACHE_CHANGED);
  }

  listenToMountPluginInstalled(): Observable<unknown> {
    return this.listenToEvent<unknown>(MOUNT_PLUGIN_INSTALLED);
  }

  listenToRcloneEngineReady(): Observable<void> {
    return this.listenToEvent<void>(RCLONE_ENGINE_READY);
  }

  listenToRcloneEngineError(): Observable<void> {
    return this.listenToEvent<void>(RCLONE_ENGINE_ERROR);
  }

  listenToRcloneEnginePasswordError(): Observable<void> {
    return this.listenToEvent<void>(RCLONE_ENGINE_PASSWORD_ERROR);
  }

  listenToRcloneEnginePathError(): Observable<void> {
    return this.listenToEvent<void>(RCLONE_ENGINE_PATH_ERROR);
  }

  listenToRcloneEngineUpdating(): Observable<void> {
    return this.listenToEvent<void>(RCLONE_ENGINE_UPDATING);
  }

  listenToRclonePasswordStored(): Observable<void> {
    return this.listenToEvent<void>(RCLONE_PASSWORD_STORED);
  }

  listenToAppEvents(): Observable<AppEventPayloadType> {
    return this.listenToEvent<AppEventPayloadType>(APP_EVENT);
  }

  listenToNetworkStatusChanged(): Observable<{ isMetered: boolean }> {
    return this.listenToEvent<{ isMetered: boolean }>(NETWORK_STATUS_CHANGED);
  }

  listenToBandwidthLimitChanged(): Observable<unknown> {
    return this.listenToEvent<unknown>(BANDWIDTH_LIMIT_CHANGED);
  }

  listenToBrowse(): Observable<string> {
    return this.listenToEvent<string>(BROWSE);
  }

  listenToSystemSettingsChanged(): Observable<SettingsChangeEvent> {
    return this.listenToEvent<SettingsChangeEvent>(SYSTEM_SETTINGS_CHANGED);
  }

  listenToScheduledTasksCacheChanged(): Observable<unknown> {
    return this.listenToEvent<unknown>(SCHEDULED_TASKS_CACHE_CHANGED);
  }

  listenToRemoteSettingsChanged(): Observable<unknown> {
    return this.listenToEvent<unknown>(REMOTE_SETTINGS_CHANGED);
  }

  listenToOAuthUrl(): Observable<OAuthUrlEvent> {
    return this.listenToEvent<OAuthUrlEvent>(RCLONE_OAUTH_URL);
  }

  listenToSystemStatus(): Observable<SystemStatusPayload> {
    return this.listenToEvent<SystemStatusPayload>(SYSTEM_STATUS);
  }
}
