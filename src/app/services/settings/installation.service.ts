import { inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { ProvisionProgressPayload, ProvisionStatus } from '@app/types';

/**
 * Service for handling installations of rclone and plugins
 * Manages the provisioning and setup of required components
 */
@Injectable({
  providedIn: 'root',
})
export class InstallationService extends TauriBaseService {
  private readonly eventListenersService = inject(EventListenersService);

  readonly rcloneProgress = signal<ProvisionProgressPayload | null>(null);
  readonly mountPluginProgress = signal<ProvisionProgressPayload | null>(null);

  constructor() {
    super();
    this.eventListenersService
      .listenToProvisionProgress()
      .pipe(takeUntilDestroyed())
      .subscribe(payload => {
        const isTerminal =
          payload.stage === 'completed' ||
          payload.stage === 'cancelled' ||
          payload.stage === 'error';
        const progress = isTerminal ? null : payload;

        if (payload.component === 'rclone') {
          this.rcloneProgress.set(progress);
        } else if (payload.component === 'mountPlugin') {
          this.mountPluginProgress.set(progress);
        }
      });

    this.restoreProvisionStatus();
  }

  private async restoreProvisionStatus(): Promise<void> {
    try {
      const status = await this.invokeCommand<ProvisionStatus>('get_provision_status');
      if (status?.rclone) {
        this.rcloneProgress.set(status.rclone);
      }
      if (status?.mountPlugin) {
        this.mountPluginProgress.set(status.mountPlugin);
      }
    } catch {
      // Ignore if unsupported (e.g. mobile/librclone) or in non-Tauri environment
    }
  }

  isCancellationError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    return msg.includes('downloadCancelled');
  }

  /**
   * Install rclone to the system
   * @param path Optional custom installation path. If null, uses default location
   */
  async installRclone(path?: string | null): Promise<string> {
    try {
      return await this.invokeWithNotification<string>(
        'provision_rclone',
        { path },
        {
          errorKey: 'repairSheet.errors.rcloneInstallFailed',
        }
      );
    } finally {
      this.rcloneProgress.set(null);
    }
  }

  /**
   * Cancel in-flight rclone provisioning/download
   */
  async cancelRcloneInstall(): Promise<void> {
    try {
      await this.invokeCommand<void>('cancel_provision_rclone');
    } catch (error) {
      console.error('Failed to cancel rclone provisioning:', error);
    } finally {
      this.rcloneProgress.set(null);
    }
  }

  /**
   * Check if mount plugin is installed
   */
  async isMountPluginInstalled(): Promise<boolean> {
    try {
      return await this.invokeWithNotification<boolean>('check_mount_plugin_installed', undefined, {
        errorKey: 'repairSheet.messages.mountPluginStatusError',
      });
    } catch (error) {
      console.error('Error checking mount plugin installation:', error);
      return false;
    }
  }

  /**
   * Install the mount plugin
   */
  async installMountPlugin(): Promise<string> {
    try {
      return await this.invokeWithNotification<string>('install_mount_plugin', undefined, {
        successKey: 'backendSuccess.rclone.mountPluginInstalled',
        errorKey: 'backendErrors.rclone.mountPluginInstallFailed',
      });
    } finally {
      this.mountPluginProgress.set(null);
    }
  }

  /**
   * Cancel in-flight mount plugin installation/download
   */
  async cancelMountPluginInstall(): Promise<void> {
    try {
      await this.invokeCommand<void>('cancel_mount_plugin_install');
    } catch (error) {
      console.error('Failed to cancel mount plugin install:', error);
    } finally {
      this.mountPluginProgress.set(null);
    }
  }
}
