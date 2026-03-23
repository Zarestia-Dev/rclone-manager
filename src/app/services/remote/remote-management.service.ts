import { Injectable } from '@angular/core';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import {
  RemoteProvider,
  ConfigRecord,
  RcConfigOption,
  RcConfigQuestionResponse,
  LocalDrive,
  CommandOption,
  INTERACTIVE_REMOTES,
} from '@app/types';

interface RawProvider {
  Name: string;
  Description: string;
  Options?: RcConfigOption[];
}

type ProvidersResponse = Record<string, RawProvider[]>;

@Injectable({ providedIn: 'root' })
export class RemoteManagementService extends TauriBaseService {
  isInteractiveRemote(type: string): boolean {
    return INTERACTIVE_REMOTES.has(type.toLowerCase());
  }

  buildOpt(userOptions: CommandOption[]): Record<string, unknown> {
    return Object.fromEntries(userOptions.map(o => [o.key, o.value]));
  }

  private mapProviders(response: ProvidersResponse): RemoteProvider[] {
    return Object.values(response)
      .flat()
      .map(p => ({ name: p.Name, description: p.Description }));
  }

  async getRemoteTypes(): Promise<RemoteProvider[]> {
    return this.mapProviders(await this.invokeCommand<ProvidersResponse>('get_remote_types'));
  }

  async getOAuthSupportedRemotes(): Promise<RemoteProvider[]> {
    return this.mapProviders(
      await this.invokeCommand<ProvidersResponse>('get_oauth_supported_remotes')
    );
  }

  async getRemoteConfigFields(type: string): Promise<RcConfigOption[]> {
    const response = await this.invokeCommand<ProvidersResponse>('get_remote_types');
    const match = Object.values(response)
      .flat()
      .find(p => p.Name === type);
    return match?.Options ?? [];
  }

  async getRemotes(): Promise<string[]> {
    return this.invokeCommand<string[]>('get_cached_remotes');
  }

  async getAllRemoteConfigs(): Promise<Record<string, unknown>> {
    return this.invokeCommand<Record<string, unknown>>('get_configs');
  }

  async createRemote(
    name: string,
    parameters: ConfigRecord,
    opt?: Record<string, unknown>
  ): Promise<void> {
    await this.invokeWithNotification(
      'create_remote',
      { name, parameters, ...(opt && { opt }) },
      {
        successKey: 'backendSuccess.remote.created',
        successParams: { name },
        errorKey: 'backendErrors.remote.configFailed',
      }
    );
  }

  async updateRemote(
    name: string,
    parameters: ConfigRecord,
    opt?: Record<string, unknown>
  ): Promise<void> {
    await this.invokeWithNotification(
      'update_remote',
      { name, parameters, ...(opt && { opt }) },
      {
        successKey: 'backendSuccess.remote.updated',
        successParams: { name },
        errorKey: 'backendErrors.remote.configFailed',
      }
    );
  }

  async deleteRemote(name: string): Promise<void> {
    await this.invokeWithNotification(
      'delete_remote',
      { name },
      {
        successKey: 'backendSuccess.remote.deleted',
        successParams: { name },
        errorKey: 'backendErrors.remote.deleteFailed',
      }
    );

    await this.invokeCommand('delete_remote_settings', { remoteName: name }).catch(() => {
      this.notificationService.showError(this.translate.instant('remotes.deleteSettingsError'));
    });
  }

  async quitOAuth(): Promise<void> {
    return this.invokeCommand('quit_rclone_oauth');
  }

  async getLocalDrives(): Promise<LocalDrive[]> {
    return this.invokeCommand<LocalDrive[]>('get_local_drives');
  }

  async startRemoteConfigInteractive(
    name: string,
    type: string,
    parameters?: Record<string, unknown>,
    opt?: Record<string, unknown>
  ): Promise<RcConfigQuestionResponse> {
    return this.invokeCommand('create_remote_interactive', {
      name,
      rcloneType: type,
      ...(parameters && { parameters }),
      ...(opt && { opt }),
    });
  }

  async continueRemoteConfigInteractive(
    name: string,
    stateToken: string,
    result: unknown,
    parameters?: Record<string, unknown>,
    opt?: Record<string, unknown>
  ): Promise<RcConfigQuestionResponse> {
    return this.invokeCommand('continue_create_remote_interactive', {
      name,
      stateToken,
      result,
      ...(parameters && { parameters }),
      ...(opt && { opt }),
    });
  }
}
