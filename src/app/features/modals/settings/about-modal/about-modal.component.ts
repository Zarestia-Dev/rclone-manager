import { CommonModule } from '@angular/common';
import { Component, HostListener, OnInit, inject } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { openUrl } from '@tauri-apps/plugin-opener';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { version as appVersion } from '../../../../../../package.json';
import { PlatformInfo, RcloneInfo, UpdateMetadata } from '@app/types';
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
import { AppUpdaterService } from '@app/services';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { FormatFileSizePipe } from 'src/app/shared/pipes/format-file-size.pipe';

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
    MatProgressBarModule,
    FormatFileSizePipe,
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

  // Platform detection
  platformInfo: PlatformInfo | null = null;
  get isFlatpak(): boolean {
    return this.platformInfo?.is_flatpak ?? false;
  }

  // Updater properties
  updateAvailable: UpdateMetadata | null = null;
  // Derived display fields from update metadata
  updateReleaseTag: string | null = null;
  updateReleaseChannel: string | null = null;
  checkingForUpdates = false;
  installingUpdate = false;
  autoCheckUpdates = true;
  updateChannel = 'stable';
  skippedVersions: string[] = [];

  downloadProgress = 0;
  downloadTotal = 0;
  downloadPercentage = 0;
  downloadInProgress = false;
  // Updater error display
  updateErrorMessage: string | null = null;
  updateErrorDismissed = false;

  readonly channels: UpdateChannel[] = [
    { value: 'stable', label: 'Stable', description: 'Recommended for most users' },
    { value: 'beta', label: 'Beta', description: 'Latest features with some testing' },
    { value: 'nightly', label: 'Nightly', description: 'Bleeding edge, may be unstable' },
  ];

  trackByChannel(index: number, channel: UpdateChannel): string {
    return channel.value;
  }

  trackByVersion(index: number, version: string): string {
    return version;
  }

  async ngOnInit(): Promise<void> {
    // Load platform info first to determine if we're in Flatpak
    await this.loadPlatformInfo();

    await this.loadRcloneInfo();
    await this.loadRclonePID();

    // Subscribe to updater service
    this.appUpdaterService.updateAvailable$.subscribe(update => {
      this.updateAvailable = update;
      // derive release tag and channel for better UI feedback
      if (update && update.releaseTag) {
        this.updateReleaseTag = update.releaseTag;
        this.updateReleaseChannel = this.getChannelFromTag(update.releaseTag);
      } else {
        this.updateReleaseTag = null;
        this.updateReleaseChannel = null;
      }
    });

    this.appUpdaterService.updateInProgress$.subscribe(inProgress => {
      this.installingUpdate = inProgress;
    });

    this.appUpdaterService.updateChannel$.subscribe(channel => {
      this.updateChannel = channel;
    });

    this.appUpdaterService.skippedVersions$.subscribe(versions => {
      this.skippedVersions = versions;
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

    // Add download status subscription
    this.appUpdaterService.downloadStatus$.subscribe(status => {
      this.downloadProgress = status.downloadedBytes;
      this.downloadTotal = status.totalBytes;
      this.downloadPercentage = status.percentage;
      this.downloadInProgress = status.downloadedBytes > 0 && !status.isComplete;

      // Update installingUpdate based on completion
      if (status.isComplete) {
        this.installingUpdate = false;
      }

      // Show backend failure messages in the UI unless the user dismissed them.
      if (status.isFailed) {
        // If it's a new failure message, reset dismissed flag so it becomes visible
        if (status.failureMessage !== this.updateErrorMessage) {
          this.updateErrorMessage = status.failureMessage ?? 'Update installation failed.';
          this.updateErrorDismissed = false;
        }
      }

      // If a new download/install starts, hide previously dismissed errors
      if (this.downloadInProgress || this.installingUpdate) {
        this.updateErrorDismissed = true;
      }
    });
  }

  private getChannelFromTag(tag: string): string {
    const t = tag.toLowerCase();
    if (t.includes('nightly')) return 'nightly';
    if (t.includes('beta')) return 'beta';
    if (t.includes('alpha')) return 'alpha';
    if (t.includes('rc')) return 'rc';
    return 'stable';
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

    // When the user starts an installation, hide any previous error banner
    this.updateErrorDismissed = true;
    this.updateErrorMessage = null;
    await this.appUpdaterService.installUpdate();
  }

  closeUpdateError(): void {
    this.updateErrorDismissed = true;
  }

  async skipUpdate(): Promise<void> {
    if (!this.updateAvailable) return;

    await this.appUpdaterService.skipVersion(this.updateAvailable.version);
  }

  async unskipVersion(version: string): Promise<void> {
    try {
      await this.appUpdaterService.unskipVersion(version);
      this.notificationService.showSuccess(`Update ${version} restored`);
    } catch (error) {
      console.error('Failed to unskip version:', error);
      this.notificationService.showError('Failed to restore update');
    }
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

  private async loadPlatformInfo(): Promise<void> {
    try {
      this.platformInfo = await this.systemInfoService.getPlatformInfo();
      console.log('Platform info:', this.platformInfo);
    } catch (error) {
      console.error('Failed to load platform info:', error);
      this.platformInfo = null;
    }
  }
}
