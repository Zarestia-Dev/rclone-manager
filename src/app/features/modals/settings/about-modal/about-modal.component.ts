import { Component, HostListener, OnInit, inject } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { version as appVersion } from '../../../../../../package.json';
import { RcloneInfo, UpdateMetadata, UpdateStatus } from '@app/types';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatBadgeModule } from '@angular/material/badge';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { FormatFileSizePipe } from 'src/app/shared/pipes/format-file-size.pipe';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked, Renderer } from 'marked';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

// Services
import {
  EventListenersService,
  SystemInfoService,
  AppUpdaterService,
  RcloneUpdateService,
  DebugService,
  NotificationService,
  DebugInfo,
} from '@app/services';

@Component({
  selector: 'app-about-modal',
  imports: [
    MatDividerModule,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatSlideToggleModule,
    MatSelectModule,
    MatFormFieldModule,
    MatBadgeModule,
    MatTooltipModule,
    MatProgressBarModule,
    FormatFileSizePipe,
    TranslateModule,
  ],
  templateUrl: './about-modal.component.html',
  styleUrls: ['./about-modal.component.scss', '../../../../styles/_shared-modal.scss'],
})
export class AboutModalComponent implements OnInit {
  readonly rCloneManagerVersion = appVersion;

  private dialogRef = inject(MatDialogRef<AboutModalComponent>);
  private systemInfoService = inject(SystemInfoService);
  private notificationService = inject(NotificationService);
  private appUpdaterService = inject(AppUpdaterService);
  private rcloneUpdateService = inject(RcloneUpdateService);
  private eventListenersService = inject(EventListenersService);
  private debugService = inject(DebugService);
  private sanitizer = inject(DomSanitizer);
  private translate = inject(TranslateService);

  currentPage = 'main';
  scrolled = false;

  // What's New overlay (separate from main navigation)
  showingWhatsNew = false;
  whatsNewType: 'app' | 'rclone' | null = null;

  rcloneInfo: RcloneInfo | null = null;
  loadingRclone = false;
  rcloneError: string | null = null;

  // Debug overlay
  showingDebugOverlay = false;
  debugInfo: DebugInfo | null = null;
  logoClickCount = 0;
  logoClickTimeout: ReturnType<typeof setTimeout> | null = null;

  buildType: string | null = null;
  updatesDisabled = false;

  // App Updater properties
  updateAvailable: UpdateMetadata | null = null;
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

  // Rclone Update properties
  rcloneUpdateStatus: UpdateStatus = {
    checking: false,
    updating: false,
    available: false,
    error: null,
    lastCheck: null,
    updateInfo: null,
  };
  rcloneAutoCheck = true;
  rcloneUpdateChannel = 'stable';
  rcloneSkippedVersions: string[] = [];

  // Restart state (set by backend after update install)
  restartRequired = false;

  readonly channels = [
    {
      value: 'stable',
      label: 'modals.about.channelStable',
      description: 'modals.about.channelStableDesc',
    },
    {
      value: 'beta',
      label: 'modals.about.channelBeta',
      description: 'modals.about.channelBetaDesc',
    },
  ];

  async ngOnInit(): Promise<void> {
    await Promise.all([
      this.loadPlatformInfo(),
      this.loadRcloneInfoWithPID(),
      this.appUpdaterService.initialize(),
      this.rcloneUpdateService.initialize(),
    ]);

    this.setupUpdaterSubscriptions();
    this.setupRcloneUpdaterSubscriptions();

    this.loadAutoCheckSetting();
    this.loadChannelSetting();
    this.loadRcloneSettings();

    this.eventListenersService.listenToRcloneEngineReady().subscribe({
      next: async () => {
        try {
          await this.loadRcloneInfoWithPID();
        } catch (error) {
          console.error('Error handling Rclone API ready event:', error);
        }
      },
    });
  }

  // What's New Methods
  showWhatsNew(type: 'app' | 'rclone'): void {
    this.whatsNewType = type;
    this.showingWhatsNew = true;
  }

  closeWhatsNew(): void {
    this.showingWhatsNew = false;
    this.whatsNewType = null;
  }
  getFormattedReleaseNotes(markdown: string | undefined | null): SafeHtml {
    if (!markdown) {
      return (
        this.sanitizer.sanitize(
          1,
          `<p>${this.translate.instant('modals.about.noReleaseNotes')}</p>`
        ) || ''
      );
    }
    // Configure marked to add target="_blank" to links
    const renderer = new Renderer();
    renderer.link = ({ href, title, text }): string => {
      const titleAttr = title ? ` title="${title}"` : '';
      return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
    };
    const html = marked.parse(markdown, { gfm: true, breaks: true, renderer });
    return this.sanitizer.sanitize(1, html) || '';
  }

  formatReleaseDate(dateString: string): string {
    try {
      const date = new Date(dateString);
      const locale = this.translate.currentLang === 'tr' ? 'tr-TR' : 'en-US';
      return date.toLocaleDateString(locale, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    } catch {
      return dateString;
    }
  }

  async loadRcloneInfoWithPID(): Promise<void> {
    this.loadingRclone = true;
    this.rcloneError = null;
    try {
      const [info, pid] = await Promise.all([
        this.systemInfoService.getRcloneInfo(),
        this.systemInfoService.getRclonePID(),
      ]);
      this.rcloneInfo = { ...info, pid } as RcloneInfo;
    } catch (error) {
      console.error('Error fetching rclone info:', error);
      this.rcloneError = this.translate.instant('modals.about.loadInfoFailed');
    } finally {
      this.loadingRclone = false;
    }
  }

  killProcess(): void {
    if (this.rcloneInfo?.pid) {
      this.systemInfoService.killProcess(this.rcloneInfo.pid).then(
        () => {
          this.notificationService.openSnackBar(
            this.translate.instant('modals.about.killSuccess'),
            this.translate.instant('common.close')
          );
          this.rcloneInfo = null;
        },
        error => {
          console.error('Failed to kill rclone process:', error);
          this.notificationService.openSnackBar(
            this.translate.instant('modals.about.killFailed'),
            this.translate.instant('common.close')
          );
        }
      );
    } else {
      this.notificationService.openSnackBar(
        this.translate.instant('modals.about.noProcessToKill'),
        this.translate.instant('common.close')
      );
    }
  }

  onScroll(content: HTMLElement): void {
    this.scrolled = content.scrollTop > 10;
  }

  @HostListener('document:keydown.escape')
  close(): void {
    if (this.showingWhatsNew) {
      this.closeWhatsNew();
    } else if (this.currentPage !== 'main') {
      this.navigateTo('main');
    } else {
      this.dialogRef.close();
    }
  }

  copyToClipboard(text: string): void {
    navigator.clipboard.writeText(text).then(
      () => {
        this.notificationService.openSnackBar(
          this.translate.instant('modals.about.copied'),
          this.translate.instant('common.close')
        );
      },
      err => {
        console.error('Failed to copy to clipboard:', err);
        this.notificationService.openSnackBar(
          this.translate.instant('modals.about.copyFailed'),
          this.translate.instant('common.close')
        );
      }
    );
  }

  navigateTo(page: string): void {
    this.currentPage = page;
  }

  getPageTitle(): string {
    switch (this.currentPage) {
      case 'Details':
        return this.translate.instant('modals.about.details');
      case 'Updates':
        return this.translate.instant('modals.about.updates');
      case 'About Rclone':
        return this.translate.instant('modals.about.aboutRclone');
      case 'Credits':
        return this.translate.instant('modals.about.credits');
      case 'Legal':
        return this.translate.instant('modals.about.legal');
      default:
        return this.currentPage;
    }
  }

  // App Updater methods
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

  async relaunchApp(): Promise<void> {
    try {
      await this.appUpdaterService.relaunchApp();
    } catch (error) {
      console.error('Failed to relaunch app:', error);
      this.notificationService.showError(this.translate.instant('updates.restartFailed'));
    }
  }

  async skipUpdate(): Promise<void> {
    if (!this.updateAvailable) return;
    await this.appUpdaterService.skipVersion(this.updateAvailable.version);
  }

  async unskipVersion(version: string): Promise<void> {
    try {
      await this.appUpdaterService.unskipVersion(version);
      this.notificationService.showSuccess(this.translate.instant('updates.restored', { version }));
    } catch (error) {
      console.error('Failed to unskip version:', error);
      this.notificationService.showError(this.translate.instant('updates.restoreFailed'));
    }
  }

  async toggleAutoCheck(): Promise<void> {
    try {
      this.autoCheckUpdates = !this.autoCheckUpdates;
      await this.appUpdaterService.setAutoCheckEnabled(this.autoCheckUpdates);
      const msg = this.autoCheckUpdates
        ? 'modals.about.autoCheckEnabled'
        : 'modals.about.autoCheckDisabled';
      this.notificationService.showSuccess(this.translate.instant(msg));
    } catch (error) {
      console.error('Failed to toggle auto-check:', error);
      this.notificationService.showError(
        this.translate.instant('modals.about.updateSettingFailed')
      );
      this.autoCheckUpdates = !this.autoCheckUpdates;
    }
  }

  async changeChannel(channel: string): Promise<void> {
    try {
      await this.appUpdaterService.setChannel(channel);
      this.updateAvailable = null;
    } catch (error) {
      console.error('Failed to change channel:', error);
      this.notificationService.showError(this.translate.instant('updates.saveChannelFailed'));
      this.updateChannel = this.appUpdaterService.getCurrentChannel();
    }
  }

  private async loadAutoCheckSetting(): Promise<void> {
    try {
      this.autoCheckUpdates = await this.appUpdaterService.getAutoCheckEnabled();
    } catch (error) {
      console.error('Failed to load auto-check setting:', error);
      this.autoCheckUpdates = true;
    }
  }

  private async loadChannelSetting(): Promise<void> {
    try {
      this.updateChannel = await this.appUpdaterService.getChannel();
    } catch (error) {
      console.error('Failed to load channel setting:', error);
      this.updateChannel = 'stable';
    }
  }

  private async loadPlatformInfo(): Promise<void> {
    try {
      this.buildType = await this.systemInfoService.getBuildType();
      this.updatesDisabled = await this.systemInfoService.areUpdatesDisabled();
    } catch (error) {
      console.error('Failed to load platform info:', error);
      this.buildType = null;
      this.updatesDisabled = false;
    }
  }

  private setupUpdaterSubscriptions(): void {
    this.appUpdaterService.updateAvailable$.subscribe(update => {
      this.updateAvailable = update;
      if (update?.releaseTag) {
        const tag = update.releaseTag.toLowerCase();
        this.updateReleaseChannel = tag.includes('beta') ? 'beta' : 'stable';
      } else {
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

    this.appUpdaterService.downloadStatus$.subscribe(status => {
      this.downloadProgress = status.downloadedBytes;
      this.downloadTotal = status.totalBytes;
      this.downloadPercentage = status.percentage;
      this.downloadInProgress = status.downloadedBytes > 0 && !status.isComplete;

      if (status.isComplete) {
        this.installingUpdate = false;
      }
    });

    // Listen for backend restart-required flag
    this.appUpdaterService.restartRequired$.subscribe(required => {
      this.restartRequired = required;
    });
  }

  // Rclone Update Methods
  private setupRcloneUpdaterSubscriptions(): void {
    this.rcloneUpdateService.updateStatus$.subscribe(status => {
      this.rcloneUpdateStatus = status;
    });

    this.rcloneUpdateService.updateChannel$.subscribe(channel => {
      this.rcloneUpdateChannel = channel;
    });

    this.rcloneUpdateService.skippedVersions$.subscribe(versions => {
      this.rcloneSkippedVersions = versions;
    });

    this.rcloneUpdateService.autoCheck$.subscribe(autoCheck => {
      this.rcloneAutoCheck = autoCheck;
    });
  }

  private async loadRcloneSettings(): Promise<void> {
    try {
      this.rcloneAutoCheck = await this.rcloneUpdateService.getAutoCheckEnabled();
      this.rcloneUpdateChannel = await this.rcloneUpdateService.getChannel();
    } catch (error) {
      console.error('Failed to load rclone update settings:', error);
    }
  }

  async checkForRcloneUpdates(): Promise<void> {
    if (this.rcloneUpdateStatus.checking) return;
    await this.rcloneUpdateService.checkForUpdates();
  }

  async installRcloneUpdate(): Promise<void> {
    if (this.rcloneUpdateStatus.updating) return;
    await this.rcloneUpdateService.performUpdate();
  }

  async skipRcloneUpdate(): Promise<void> {
    if (!this.rcloneUpdateStatus.updateInfo) return;
    const version =
      this.rcloneUpdateStatus.updateInfo.latest_version_clean ||
      this.rcloneUpdateStatus.updateInfo.latest_version;
    await this.rcloneUpdateService.skipVersion(version);
  }

  async unskipRcloneVersion(version: string): Promise<void> {
    await this.rcloneUpdateService.unskipVersion(version);
  }

  async toggleRcloneAutoCheck(): Promise<void> {
    await this.rcloneUpdateService.setAutoCheckEnabled(!this.rcloneAutoCheck);
  }

  async changeRcloneChannel(channel: string): Promise<void> {
    await this.rcloneUpdateService.setChannel(channel);
    this.rcloneUpdateStatus = {
      ...this.rcloneUpdateStatus,
      available: false,
      updateInfo: null,
    };
  }

  // Debug Overlay Methods
  onLogoClick(): void {
    this.logoClickCount++;

    // Reset timeout on each click
    if (this.logoClickTimeout) {
      clearTimeout(this.logoClickTimeout);
    }

    // If 5 clicks within 2 seconds, show debug overlay
    if (this.logoClickCount >= 5) {
      this.logoClickCount = 0;
      this.showDebugOverlay();
      return;
    }

    // Reset click count after 2 seconds of no clicks
    this.logoClickTimeout = setTimeout(() => {
      this.logoClickCount = 0;
    }, 2000);
  }

  async showDebugOverlay(): Promise<void> {
    this.showingDebugOverlay = true;
    try {
      this.debugInfo = await this.debugService.getDebugInfo();
    } catch (error) {
      console.error('Failed to load debug info:', error);
    }
  }

  closeDebugOverlay(): void {
    this.showingDebugOverlay = false;
  }

  async openFolder(folderType: 'logs' | 'config' | 'cache'): Promise<void> {
    try {
      await this.debugService.openFolder(folderType);
    } catch {
      // Error already handled by service
    }
  }

  async openDevTools(): Promise<void> {
    try {
      await this.debugService.openDevTools();
    } catch {
      // Error already handled by service
    }
  }
}
