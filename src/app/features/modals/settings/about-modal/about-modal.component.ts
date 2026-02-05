import { Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { version as appVersion } from '../../../../../../package.json';
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
import { NgTemplateOutlet } from '@angular/common';

// Services
import {
  SystemInfoService,
  AppUpdaterService,
  RcloneUpdateService,
  DebugService,
  NotificationService,
  DebugInfo,
  RcloneStatusService,
  BackendService,
  ModalService,
} from '@app/services';
import { toSignal } from '@angular/core/rxjs-interop';

// Configure renderer once
const renderer = new Renderer();
renderer.link = ({ href, title, text }): string => {
  const titleAttr = title ? ` title="${title}"` : '';
  return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
};

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
    NgTemplateOutlet,
  ],
  templateUrl: './about-modal.component.html',
  styleUrls: ['./about-modal.component.scss', '../../../../styles/_shared-modal.scss'],
})
export class AboutModalComponent implements OnInit {
  readonly rCloneManagerVersion = appVersion;

  private dialogRef = inject(MatDialogRef<AboutModalComponent>);
  private systemInfoService = inject(SystemInfoService);
  private notificationService = inject(NotificationService);
  protected appUpdaterService = inject(AppUpdaterService);
  protected rcloneUpdateService = inject(RcloneUpdateService);
  private debugService = inject(DebugService);
  private sanitizer = inject(DomSanitizer);
  private translate = inject(TranslateService);

  readonly rcloneStatusService = inject(RcloneStatusService);
  readonly backendService = inject(BackendService);
  readonly modalService = inject(ModalService);

  // Local State Signals
  readonly currentPage = signal<string>('main');
  readonly scrolled = signal<boolean>(false);
  readonly showingWhatsNew = signal<boolean>(false);
  readonly whatsNewType = signal<'app' | 'rclone' | null>(null);
  readonly showingDebugOverlay = signal<boolean>(false);
  readonly debugInfo = signal<DebugInfo | null>(null);

  // App Updater Signals
  readonly appAutoCheckUpdates = signal<boolean>(true); // Initial default, updated in init
  readonly appUpdateAvailable = toSignal(this.appUpdaterService.updateAvailable$, {
    initialValue: null,
  });
  readonly appUpdateInProgress = toSignal(this.appUpdaterService.updateInProgress$, {
    initialValue: false,
  });
  readonly appUpdateChannel = toSignal(this.appUpdaterService.updateChannel$, {
    initialValue: 'stable',
  });
  readonly appSkippedVersions = toSignal(this.appUpdaterService.skippedVersions$, {
    initialValue: [],
  });
  readonly appRestartRequired = toSignal(this.appUpdaterService.restartRequired$, {
    initialValue: false,
  });
  readonly appDownloadStatus = toSignal(this.appUpdaterService.downloadStatus$);

  // Computed App Updater Signals
  readonly appUpdateReleaseChannel = computed(() => {
    const update = this.appUpdateAvailable();
    if (!update?.releaseTag) return null;
    return update.releaseTag.toLowerCase().includes('beta') ? 'beta' : 'stable';
  });

  readonly appDownloadProgress = computed(() => this.appDownloadStatus()?.downloadedBytes || 0);
  readonly appDownloadTotal = computed(() => this.appDownloadStatus()?.totalBytes || 0);
  readonly appDownloadPercentage = computed(() => this.appDownloadStatus()?.percentage || 0);
  readonly appDownloadInProgress = computed(() => {
    const status = this.appDownloadStatus();
    return (status?.downloadedBytes || 0) > 0 && !status?.isComplete;
  });

  // Rclone Updater Signals
  readonly rcloneUpdateStatus = toSignal(this.rcloneUpdateService.updateStatus$, {
    initialValue: {
      checking: false,
      updating: false,
      available: false,
      error: null,
      lastCheck: null,
      updateInfo: null,
    },
  });
  readonly rcloneUpdateChannel = toSignal(this.rcloneUpdateService.updateChannel$, {
    initialValue: 'stable',
  });
  readonly rcloneSkippedVersions = toSignal(this.rcloneUpdateService.skippedVersions$, {
    initialValue: [],
  });
  readonly rcloneAutoCheck = toSignal(this.rcloneUpdateService.autoCheck$, { initialValue: true });

  // Rclone Computed
  readonly rcloneInfo = computed(() => {
    const info = this.rcloneStatusService.rcloneInfo();
    const pid = this.rcloneStatusService.rclonePID();
    if (!info) return null;
    return { ...info, pid };
  });

  readonly isLocalBackend = computed(() => this.backendService.activeBackend() === 'Local');

  readonly loadingRclone = this.rcloneStatusService.isLoading;

  readonly rcloneError = computed(() =>
    this.rcloneStatusService.rcloneStatus() === 'error'
      ? this.translate.instant('modals.about.loadInfoFailed')
      : null
  );

  readonly memoryStats = this.rcloneStatusService.memoryUsage;
  readonly runningGc = signal(false);
  readonly showingMemoryOverlay = signal(false);

  // Platform Info Signals
  readonly buildType = signal<string | null>(null);
  readonly updatesDisabled = signal<boolean>(false);

  // Fscache Signals
  readonly fsCacheEntries = signal<number>(0);
  readonly clearingFsCache = signal<boolean>(false);

  // Constants
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

  // Logic
  protected logoClickCount = 0;
  private logoClickTimeout: ReturnType<typeof setTimeout> | null = null;
  checkingForUpdates = false; // Kept as simple flag for async method guard if needed

  async ngOnInit(): Promise<void> {
    // Initial data loading that isn't purely reactive yet
    await this.loadPlatformInfo();

    // Load manual setting for app auto-check
    this.loadAppAutoCheckSetting();
    this.loadFsCacheEntries();
  }

  // --- Actions ---

  showWhatsNew(type: 'app' | 'rclone'): void {
    this.whatsNewType.set(type);
    this.showingWhatsNew.set(true);
  }

  closeWhatsNew(): void {
    this.showingWhatsNew.set(false);
    this.whatsNewType.set(null);
  }

  @HostListener('document:keydown.escape')
  close(): void {
    if (this.showingWhatsNew()) {
      this.closeWhatsNew();
    } else if (this.currentPage() !== 'main') {
      this.navigateTo('main');
    } else {
      this.modalService.animatedClose(this.dialogRef);
    }
  }

  navigateTo(page: string): void {
    this.currentPage.set(page);
  }

  getPageTitle(): string {
    const page = this.currentPage();
    switch (page) {
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
        return page;
    }
  }

  // --- App Updater Actions ---

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
    // Prevent double execution
    if (this.appUpdateInProgress()) return;
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
    const update = this.appUpdateAvailable();
    if (!update) return;
    await this.appUpdaterService.skipVersion(update.version);
  }

  async unskipVersion(version: string): Promise<void> {
    this.checkingForUpdates = true;
    try {
      await this.appUpdaterService.unskipVersion(version);
      this.notificationService.showSuccess(this.translate.instant('updates.restored', { version }));
    } catch (error) {
      console.error('Failed to unskip version:', error);
      this.notificationService.showError(this.translate.instant('updates.restoreFailed'));
    } finally {
      this.checkingForUpdates = false;
    }
  }

  async toggleAutoCheck(): Promise<void> {
    const current = this.appAutoCheckUpdates();
    try {
      this.appAutoCheckUpdates.set(!current); // Optimistic UI update
      await this.appUpdaterService.setAutoCheckEnabled(!current);
      const msg = !current ? 'modals.about.autoCheckEnabled' : 'modals.about.autoCheckDisabled';
      this.notificationService.showSuccess(this.translate.instant(msg));
    } catch (error) {
      console.error('Failed to toggle auto-check:', error);
      this.notificationService.showError(
        this.translate.instant('modals.about.updateSettingFailed')
      );
      this.appAutoCheckUpdates.set(current); // Revert on failure
    }
  }

  async changeChannel(channel: string): Promise<void> {
    await this.appUpdaterService.setChannel(channel);
  }

  private async loadAppAutoCheckSetting(): Promise<void> {
    try {
      const enabled = await this.appUpdaterService.getAutoCheckEnabled();
      this.appAutoCheckUpdates.set(enabled);
    } catch (error) {
      console.error('Failed to load auto-check setting:', error);
    }
  }

  // --- Rclone Updater Actions ---

  async checkForRcloneUpdates(): Promise<void> {
    if (this.rcloneUpdateStatus().checking) return;
    await this.rcloneUpdateService.checkForUpdates();
  }

  async installRcloneUpdate(): Promise<void> {
    if (this.rcloneUpdateStatus().updating) return;
    await this.rcloneUpdateService.performUpdate();
  }

  async skipRcloneUpdate(): Promise<void> {
    const status = this.rcloneUpdateStatus();
    if (!status.updateInfo) return;
    const version = status.updateInfo.latest_version_clean || status.updateInfo.latest_version;
    await this.rcloneUpdateService.skipVersion(version);
  }

  async unskipRcloneVersion(version: string): Promise<void> {
    await this.rcloneUpdateService.unskipVersion(version);
  }

  async toggleRcloneAutoCheck(): Promise<void> {
    await this.rcloneUpdateService.setAutoCheckEnabled(!this.rcloneAutoCheck());
  }

  async changeRcloneChannel(channel: string): Promise<void> {
    await this.rcloneUpdateService.setChannel(channel);
  }

  // --- Other Methods ---

  private async loadPlatformInfo(): Promise<void> {
    try {
      const type = await this.systemInfoService.getBuildType();
      this.buildType.set(type);
      const disabled = await this.systemInfoService.areUpdatesDisabled();
      this.updatesDisabled.set(disabled);
    } catch (error) {
      console.error('Failed to load platform info:', error);
    }
  }

  async quitRcloneEngine(): Promise<void> {
    try {
      const activeBackend = this.backendService.activeBackend();
      const isLocal = activeBackend === 'Local';

      if (isLocal) {
        const pid = this.rcloneStatusService.rclonePID();
        if (!pid) {
          this.notificationService.openSnackBar(
            this.translate.instant('modals.about.noProcessToKill'),
            this.translate.instant('common.close')
          );
          return;
        }
        await this.systemInfoService.killProcess(pid);
      } else {
        await this.systemInfoService.quitRcloneEngine();
      }

      this.notificationService.openSnackBar(
        this.translate.instant('modals.about.killSuccess'),
        this.translate.instant('common.close')
      );
      await this.rcloneStatusService.refresh();
    } catch (error) {
      console.error('Failed to quit rclone engine:', error);
      this.notificationService.openSnackBar(
        this.translate.instant('modals.about.killFailed'),
        this.translate.instant('common.close')
      );
    }
  }

  async runGarbageCollector(): Promise<void> {
    if (this.runningGc()) return;
    this.runningGc.set(true);
    try {
      await this.systemInfoService.runGarbageCollector();
      this.notificationService.showSuccess(this.translate.instant('modals.about.gcSuccess'));
      // Trigger immediate refresh to see memory changes
      await this.rcloneStatusService.refresh();
    } catch (error) {
      console.error('Failed to run garbage collector:', error);
      this.notificationService.showError(this.translate.instant('modals.about.gcFailed'));
    } finally {
      this.runningGc.set(false);
    }
  }

  async loadFsCacheEntries(): Promise<void> {
    try {
      const entries = await this.systemInfoService.getFsCacheEntries();
      this.fsCacheEntries.set(entries);
    } catch (error) {
      console.error('Failed to load fscache entries:', error);
    }
  }

  async clearFsCache(): Promise<void> {
    if (this.clearingFsCache()) return;
    this.clearingFsCache.set(true);
    try {
      await this.systemInfoService.clearFsCache();
      this.notificationService.showSuccess(this.translate.instant('modals.about.cacheCleared'));
      await this.loadFsCacheEntries();
    } catch (error) {
      console.error('Failed to clear fscache:', error);
      this.notificationService.showError(this.translate.instant('modals.about.cacheClearFailed'));
    } finally {
      this.clearingFsCache.set(false);
    }
  }

  onScroll(content: HTMLElement): void {
    this.scrolled.set(content.scrollTop > 10);
  }

  onLogoClick(): void {
    this.logoClickCount++;
    if (this.logoClickTimeout) clearTimeout(this.logoClickTimeout);

    if (this.logoClickCount >= 5) {
      this.logoClickCount = 0;
      this.showDebugOverlay();
      return;
    }

    this.logoClickTimeout = setTimeout(() => {
      this.logoClickCount = 0;
    }, 2000);
  }

  async showDebugOverlay(): Promise<void> {
    this.showingDebugOverlay.set(true);
    try {
      const info = await this.debugService.getDebugInfo();
      this.debugInfo.set(info);
    } catch (error) {
      console.error('Failed to load debug info:', error);
    }
  }

  closeDebugOverlay(): void {
    this.showingDebugOverlay.set(false);
  }

  showMemoryOverlay(): void {
    this.showingMemoryOverlay.set(true);
  }

  closeMemoryOverlay(): void {
    this.showingMemoryOverlay.set(false);
  }

  async openFolder(folderType: 'logs' | 'config' | 'cache'): Promise<void> {
    await this.debugService.openFolder(folderType);
  }

  async openDevTools(): Promise<void> {
    await this.debugService.openDevTools();
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

  getFormattedReleaseNotes(markdown: string | undefined | null): SafeHtml {
    if (!markdown) {
      return (
        this.sanitizer.sanitize(
          1,
          `<p>${this.translate.instant('modals.about.noReleaseNotes')}</p>`
        ) || ''
      );
    }
    // Renderer is now static global const
    const html = marked.parse(markdown, { gfm: true, breaks: true, renderer });
    return this.sanitizer.sanitize(1, html) || '';
  }

  getChannelLabel(channel: string | null | undefined): string {
    if (!channel) return '';
    const ch = this.channels.find(c => c.value === channel);
    return ch ? ch.label : channel;
  }
}
