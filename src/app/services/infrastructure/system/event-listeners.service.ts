import { Injectable } from '@angular/core';
import { Observable, fromEvent, filter, map } from 'rxjs';
import {
  AppEventPayloadType,
  MOUNT_STATE_CHANGED,
  REMOTE_CACHE_CHANGED,
  JOB_CACHE_CHANGED,
  MOUNT_PLUGIN_INSTALLED,
  APP_EVENT,
  NETWORK_STATUS_CHANGED,
  BANDWIDTH_LIMIT_CHANGED,
  SERVE_STATE_CHANGED,
  SYSTEM_STATUS,
  RCLONE_ENGINE_STATUS_CHANGED,
  EngineStatus,
  RCLONE_PASSWORD_STORED,
  BROWSE,
  SYSTEM_SETTINGS_CHANGED,
  AUTOMATIONS_CACHE_CHANGED,
  REMOTE_SETTINGS_CHANGED,
  SettingsChangeEvent,
  RCLONE_OAUTH_URL,
  OAuthUrlEvent,
  JobChangeEvent,
  SystemStatusPayload,
  UpdateInfo,
  DownloadStatus,
  EngineErrorType,
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

  listenToEngineStatus(): Observable<EngineStatus> {
    return this.listenToEvent<EngineStatus>(RCLONE_ENGINE_STATUS_CHANGED);
  }

  listenToRcloneEngineReady(): Observable<void> {
    return this.listenToEngineStatus().pipe(
      filter(event => event.status === 'ready'),
      map(() => undefined)
    );
  }

  listenToRcloneEngineUpdating(): Observable<void> {
    return this.listenToEngineStatus().pipe(
      filter(event => event.status === 'updating'),
      map(() => undefined)
    );
  }

  listenToEngineRestarted(reason?: string): Observable<{ reason: string }> {
    return this.listenToEngineStatus().pipe(
      filter(event => event.status === 'restarted'),
      map(event => event.payload as { reason: string }),
      filter(payload => !reason || payload.reason === reason)
    );
  }

  listenToRcloneEnginePathError(): Observable<void> {
    return this.listenToEngineStatus().pipe(
      filter(event => event.status === 'pathError'),
      map(() => undefined)
    );
  }

  listenToRcloneEngineVersionError(): Observable<{ version: string; required: string }> {
    return this.listenToEngineStatus().pipe(
      filter(event => event.status === 'versionError'),
      map(event => event.payload as { version: string; required: string })
    );
  }

  listenToRcloneEnginePasswordError(): Observable<void> {
    return this.listenToEngineStatus().pipe(
      filter(event => event.status === 'passwordError'),
      map(() => undefined)
    );
  }

  listenToEngineErrorState(): Observable<EngineErrorType> {
    return this.listenToEngineStatus().pipe(
      map(state => {
        switch (state.status) {
          case 'passwordError':
            return 'password' as const;
          case 'pathError':
            return 'path' as const;
          case 'versionError':
            return 'version' as const;
          case 'error':
            return 'generic' as const;
          default:
            return null;
        }
      })
    );
  }

  listenToAppUpdateFound(): Observable<UpdateInfo> {
    return this.listenToAppEvents().pipe(
      filter(event => event.status === 'update_found' && !!event.data),
      map(event => event.data as UpdateInfo)
    );
  }

  listenToAppDownloadProgress(): Observable<DownloadStatus> {
    return this.listenToAppEvents().pipe(
      filter(event => event.status === 'download_progress' && !!event.data),
      map(event => event.data as DownloadStatus)
    );
  }

  listenToRcloneUpdateFound(): Observable<UpdateInfo> {
    return this.listenToAppEvents().pipe(
      filter(event => event.status === 'rclone_update_found' && !!event.data),
      map(event => event.data as UpdateInfo)
    );
  }

  listenToAppShuttingDown(): Observable<void> {
    return this.listenToAppEvents().pipe(
      filter(event => event.status === 'shutting_down'),
      map(() => undefined)
    );
  }

  listenToLanguageChanged(): Observable<string> {
    return this.listenToAppEvents().pipe(
      filter(event => event.status === 'language_changed' && !!event.language),
      map(event => event.language as string)
    );
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

  listenToAutomationsCacheChanged(): Observable<unknown> {
    return this.listenToEvent<unknown>(AUTOMATIONS_CACHE_CHANGED);
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
