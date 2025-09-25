import { CommonModule } from '@angular/common';
import { Component, HostListener, OnInit, inject } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { openUrl } from '@tauri-apps/plugin-opener';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { version as appVersion } from '../../../../../../package.json';
import { RcloneInfo } from '@app/types';
import { RcloneUpdateIconComponent } from '../../../../shared/components/rclone-update-icon/rclone-update-icon.component';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatBadgeModule } from '@angular/material/badge';
import { MatTooltipModule } from '@angular/material/tooltip';

// Services
import { AnimationsService } from '../../../../shared/services/animations.service';
import { EventListenersService } from '@app/services';
import { SystemInfoService } from '@app/services';
import { NotificationService } from 'src/app/shared/services/notification.service';
import { AppUpdaterService, UpdateMetadata } from '@app/services';

interface UpdateChannel {
  value: string;
  label: string;
  description: string;
}

@Component({
  selector: 'app-about-modal',
  imports: [
    CommonModule,
    MatDividerModule,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatSlideToggleModule,
    MatSelectModule,
    MatFormFieldModule,
    MatBadgeModule,
    MatTooltipModule,
    RcloneUpdateIconComponent,
  ],
  templateUrl: './about-modal.component.html',
  styleUrl: './about-modal.component.scss',
  animations: [AnimationsService.slideOverlay()],
})
export class AboutModalComponent implements OnInit {
  readonly rCloneManagerVersion = appVersion;

  dialogRef = inject(MatDialogRef<AboutModalComponent>);
  systemInfoService = inject(SystemInfoService);
  notificationService = inject(NotificationService);
  appUpdaterService = inject(AppUpdaterService);

  currentPage = 'main';

  scrolled = false;

  rcloneInfo: RcloneInfo | null = null;
  loadingRclone = false;
  rcloneError: string | null = null;
  private eventListenersService = inject(EventListenersService);

  // Updater properties
  updateAvailable: UpdateMetadata | null = null;
  checkingForUpdates = false;
  installingUpdate = false;
  autoCheckUpdates = true;
  updateChannel = 'stable';

  readonly channels: UpdateChannel[] = [
    { value: 'stable', label: 'Stable', description: 'Recommended for most users' },
    { value: 'beta', label: 'Beta', description: 'Latest features with some testing' },
    { value: 'nightly', label: 'Nightly', description: 'Bleeding edge, may be unstable' },
  ];

  trackByChannel(index: number, channel: UpdateChannel): string {
    return channel.value;
  }

  async ngOnInit(): Promise<void> {
    await this.loadRcloneInfo();
    await this.loadRclonePID();

    // Subscribe to updater service
    this.appUpdaterService.updateAvailable$.subscribe(update => {
      this.updateAvailable = update;
    });

    this.appUpdaterService.updateInProgress$.subscribe(inProgress => {
      this.installingUpdate = inProgress;
    });

    this.appUpdaterService.updateChannel$.subscribe(channel => {
      this.updateChannel = channel;
    });

    // Load settings
    this.loadAutoCheckSetting();
    this.loadChannelSetting();

    this.eventListenersService.listenToRcloneEngine().subscribe({
      next: async event => {
        try {
          console.log('Rclone Engine event payload:', event);

          // Handle both new structured payload and legacy string payload
          let isReady = false;

          if (typeof event === 'object' && event?.status === 'ready') {
            // New structured payload
            isReady = true;
            console.log('Rclone API ready (new format):', event);
          }

          if (isReady) {
            await this.loadRcloneInfo();
            await this.loadRclonePID();
          }
        } catch (error) {
          console.error('Error handling Rclone API ready event:', error);
        }
      },
    });
  }

  async loadRcloneInfo(): Promise<void> {
    this.loadingRclone = true;
    this.rcloneError = null;
    try {
      this.rcloneInfo = await this.systemInfoService.getRcloneInfo();
    } catch (error) {
      console.error('Error fetching rclone info:', error);
      this.rcloneError = 'Failed to load rclone info.';
    } finally {
      this.loadingRclone = false;
    }
  }

  async loadRclonePID(): Promise<void> {
    this.loadingRclone = true;
    this.rcloneError = null;
    try {
      const pid = await this.systemInfoService.getRclonePID();
      if (this.rcloneInfo) {
        this.rcloneInfo = {
          ...this.rcloneInfo,
          pid: pid,
        };
      }
    } catch (error) {
      console.error('Error fetching rclone PID:', error);
      this.rcloneError = 'Failed to load rclone PID.';
      this.notificationService.openSnackBar(this.rcloneError, 'Close');
    } finally {
      this.loadingRclone = false;
    }
  }

  killProcess(): void {
    if (this.rcloneInfo?.pid) {
      this.systemInfoService.killProcess(this.rcloneInfo.pid).then(
        () => {
          this.notificationService.openSnackBar('Rclone process killed successfully', 'Close');
          this.rcloneInfo = null; // Clear info after killing
        },
        error => {
          console.error('Failed to kill rclone process:', error);
          this.notificationService.openSnackBar('Failed to kill rclone process', 'Close');
        }
      );
    } else {
      this.notificationService.openSnackBar('No rclone process to kill', 'Close');
    }
  }

  onScroll(content: HTMLElement): void {
    this.scrolled = content.scrollTop > 10;
  }

  @HostListener('document:keydown.escape', ['$event'])
  onEscKeyPress(): void {
    this.dialogRef.close();
  }

  openLink(link: string): void {
    openUrl(link);
  }

  copyToClipboard(text: string): void {
    navigator.clipboard.writeText(text).then(
      () => {
        this.notificationService.openSnackBar('Copied to clipboard', 'Close');
      },
      err => {
        console.error('Failed to copy to clipboard:', err);
        this.notificationService.openSnackBar('Failed to copy to clipboard', 'Close');
      }
    );
  }

  @HostListener('document:keydown.escape', ['$event'])
  close(): void {
    this.dialogRef.close();
  }

  navigateTo(page: string): void {
    this.currentPage = page;
  }

  // Updater methods
  async checkForUpdates(): Promise<void> {
    if (this.checkingForUpdates) return;

    this.checkingForUpdates = true;
    try {
      await this.appUpdaterService.checkForUpdates();
    } finally {
      this.checkingForUpdates = false;
    }
  }

  async installUpdate(): Promise<void> {
    if (this.installingUpdate) return;

    await this.appUpdaterService.installUpdate();
  }

  async skipUpdate(): Promise<void> {
    if (!this.updateAvailable) return;

    await this.appUpdaterService.skipVersion(this.updateAvailable.version);
  }

  async toggleAutoCheck(): Promise<void> {
    try {
      this.autoCheckUpdates = !this.autoCheckUpdates;
      await this.appUpdaterService.setAutoCheckEnabled(this.autoCheckUpdates);
      this.notificationService.showSuccess(
        `Auto-check updates ${this.autoCheckUpdates ? 'enabled' : 'disabled'}`
      );
    } catch (error) {
      console.error('Failed to toggle auto-check:', error);
      this.notificationService.showError('Failed to update setting');
      // Revert on error
      this.autoCheckUpdates = !this.autoCheckUpdates;
    }
  }

  async changeChannel(channel: string): Promise<void> {
    try {
      await this.appUpdaterService.setChannel(channel);
      // Clear current update when channel changes
      this.updateAvailable = null;
    } catch (error) {
      console.error('Failed to change channel:', error);
      this.notificationService.showError('Failed to change update channel');
      // Revert on error
      this.updateChannel = this.appUpdaterService.getCurrentChannel();
    }
  }

  private async loadAutoCheckSetting(): Promise<void> {
    try {
      this.autoCheckUpdates = await this.appUpdaterService.getAutoCheckEnabled();
    } catch (error) {
      console.error('Failed to load auto-check setting:', error);
      this.autoCheckUpdates = true; // Default fallback
    }
  }

  private async loadChannelSetting(): Promise<void> {
    try {
      this.updateChannel = await this.appUpdaterService.getChannel();
    } catch (error) {
      console.error('Failed to load channel setting:', error);
      this.updateChannel = 'stable'; // Default fallback
    }
  }
}
