import {
  Component,
  OnInit,
  computed,
  inject,
  signal,
  ChangeDetectionStrategy,
  DestroyRef,
} from '@angular/core';
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
import { CommonModule, NgTemplateOutlet } from '@angular/common';

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
import { CopyToClipboardDirective } from '../../../../shared/directives/copy-to-clipboard.directive';

// Configure renderer once at module level
const renderer = new Renderer();
renderer.link = ({ href, title, text }): string => {
  const titleAttr = title ? ` title="${title}"` : '';
  return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
};

export type ViewId =
  | 'details'
  | 'updates'
  | 'about-rclone'
  | 'credits'
  | 'legal'
  | 'whats-new-app'
  | 'whats-new-rclone'
  | 'debug'
  | 'memory';

export interface OverlayView {
  id: ViewId;
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
    MatProgressBarModule,
    FormatFileSizePipe,
    TranslateModule,
    NgTemplateOutlet,
    CopyToClipboardDirective,
  ],
  templateUrl: './about-modal.component.html',
  styleUrls: ['./about-modal.component.scss', '../../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'close()' },
})
export class AboutModalComponent implements OnInit {
  readonly rCloneManagerVersion = appVersion;

  private readonly dialogRef = inject(MatDialogRef<AboutModalComponent>);
  private readonly systemInfoService = inject(SystemInfoService);
  private readonly notificationService = inject(NotificationService);
  protected readonly appUpdaterService = inject(AppUpdaterService);
  protected readonly rcloneUpdateService = inject(RcloneUpdateService);
  private readonly debugService = inject(DebugService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);

  readonly rcloneStatusService = inject(RcloneStatusService);
  readonly backendService = inject(BackendService);
  readonly modalService = inject(ModalService);

  // ---------------------------------------------------------------------------
  // Navigation state
  // ---------------------------------------------------------------------------

  readonly overlayStack = signal<OverlayView[]>([]);
  readonly scrolled = signal(false);

  readonly currentView = computed(() => {
    const stack = this.overlayStack();
    return stack.length > 0 ? stack[stack.length - 1] : { id: 'main' as const };
  });

  // ---------------------------------------------------------------------------
  // App updater signals
  // ---------------------------------------------------------------------------

  // Directly alias service signals — no local mirror needed.
  readonly appAutoCheckUpdates = this.appUpdaterService.autoCheckEnabled;
  readonly appUpdateAvailable = this.appUpdaterService.updateAvailable;
  readonly appUpdateInProgress = this.appUpdaterService.updateInProgress;
  readonly appUpdateChannel = this.appUpdaterService.updateChannel;
  readonly appSkippedVersions = this.appUpdaterService.skippedVersions;
  readonly appRestartRequired = this.appUpdaterService.restartRequired;
  readonly appDownloadStatus = this.appUpdaterService.downloadStatus;

  readonly appUpdateReleaseChannel = computed(() => {
    const tag = this.appUpdateAvailable()?.releaseTag;
    if (!tag) return null;
    return tag.toLowerCase().includes('beta') ? 'beta' : 'stable';
  });

  readonly appDownloadProgress = computed(() => this.appDownloadStatus()?.downloadedBytes ?? 0);
  readonly appDownloadTotal = computed(() => this.appDownloadStatus()?.totalBytes ?? 0);
  readonly appDownloadPercentage = computed(() => this.appDownloadStatus()?.percentage ?? 0);
  readonly appDownloadInProgress = computed(() => {
    const status = this.appDownloadStatus();
    return !!this.appUpdateInProgress() && !status?.isComplete && !status?.isFailed;
  });

  // ---------------------------------------------------------------------------
  // Rclone updater signals
  // ---------------------------------------------------------------------------

  readonly rcloneUpdateStatus = this.rcloneUpdateService.updateStatus;
  readonly rcloneUpdateChannel = this.rcloneUpdateService.updateChannel;
  readonly rcloneSkippedVersions = this.rcloneUpdateService.skippedVersions;
  readonly rcloneAutoCheck = this.rcloneUpdateService.autoCheckEnabled;

  readonly restartingApp = signal(false);
  readonly restartingRcloneEngine = signal(false);
  readonly checkingForUpdates = signal(false);

  // ---------------------------------------------------------------------------
  // Rclone info
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Platform / fscache
  // ---------------------------------------------------------------------------

  // Sourced from the service — already resolved during service init.
  readonly buildType = computed(() => this.appUpdaterService.buildType());
  readonly fsCacheEntries = signal(0);
  readonly clearingFsCache = signal(false);

  // ---------------------------------------------------------------------------
  // Debug
  // ---------------------------------------------------------------------------

  readonly debugInfo = signal<DebugInfo | null>(null);

  // ---------------------------------------------------------------------------
  // Easter egg
  // ---------------------------------------------------------------------------

  // Must be a signal — plain properties are invisible to zoneless OnPush CD.
  readonly logoClickCount = signal(0);
  private logoClickTimeout: ReturnType<typeof setTimeout> | null = null;

  // ---------------------------------------------------------------------------
  // Memoized markdown rendering
  // ---------------------------------------------------------------------------

  readonly formattedAppReleaseNotes = computed(() =>
    this.formatReleaseNotes(this.appUpdateAvailable()?.releaseNotes)
  );

  readonly formattedRcloneReleaseNotes = computed(() =>
    this.formatReleaseNotes(this.rcloneUpdateStatus().updateInfo?.release_notes)
  );

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

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

  readonly navItems: { label: string; viewId: ViewId; icon: string }[] = [
    { label: 'modals.about.details', viewId: 'details', icon: 'chevron-right' },
    { label: 'modals.about.aboutRclone', viewId: 'about-rclone', icon: 'chevron-right' },
  ];

  readonly bottomNavItems: { label: string; viewId: ViewId; icon: string }[] = [
    { label: 'modals.about.credits', viewId: 'credits', icon: 'chevron-right' },
    { label: 'modals.about.legal', viewId: 'legal', icon: 'chevron-right' },
  ];

  readonly rcloneNavBadge = computed(() => {
    const s = this.rcloneUpdateStatus();
    return s.available || s.readyToRestart;
  });

  // Static lookup — extracted to a field so getPageTitle() doesn't allocate a
  // new object literal on every call.
  private readonly pageTitleMap: Partial<Record<ViewId | 'main', string>> = {
    details: 'modals.about.details',
    updates: 'modals.about.updates',
    'about-rclone': 'modals.about.aboutRclone',
    credits: 'modals.about.credits',
    legal: 'modals.about.legal',
    'whats-new-app': 'modals.about.whatsNew',
    'whats-new-rclone': 'modals.about.whatsNew',
    debug: 'modals.about.debugTools',
    memory: 'modals.about.memoryStats',
  };

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  ngOnInit(): void {
    this.loadFsCacheEntries();

    this.destroyRef.onDestroy(() => {
      if (this.logoClickTimeout) {
        clearTimeout(this.logoClickTimeout);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  navigateTo(viewId: ViewId): void {
    this.overlayStack.update(stack => [...stack, { id: viewId }]);
  }

  goBack(): void {
    this.overlayStack.update(stack => stack.slice(0, -1));
  }

  showWhatsNew(type: 'app' | 'rclone'): void {
    this.navigateTo(`whats-new-${type}` as ViewId);
  }

  close(): void {
    if (this.overlayStack().length > 0) {
      this.goBack();
    } else {
      this.modalService.animatedClose(this.dialogRef);
    }
  }

  getPageTitle(viewId?: ViewId): string {
    const id = viewId ?? this.currentView().id;
    const key = this.pageTitleMap[id];
    return key ? this.translate.instant(key) : '';
  }

  // ---------------------------------------------------------------------------
  // App updater actions
  // ---------------------------------------------------------------------------

  async checkForUpdates(): Promise<void> {
    if (this.checkingForUpdates()) return;
    this.checkingForUpdates.set(true);
    try {
      await this.appUpdaterService.checkForUpdates();
    } finally {
      this.checkingForUpdates.set(false);
    }
  }

  async installUpdate(): Promise<void> {
    if (this.appUpdateInProgress()) return;
    await this.appUpdaterService.installUpdate();
  }

  async finishUpdate(): Promise<void> {
    if (this.restartingApp()) return;
    this.restartingApp.set(true);
    try {
      await this.appUpdaterService.finishUpdate();
    } catch (error) {
      console.error('Failed to finish update:', error);
      this.notificationService.showError(this.translate.instant('updates.restartFailed'));
    } finally {
      this.restartingApp.set(false);
    }
  }

  async restartApp(): Promise<void> {
    if (this.restartingApp()) return;
    this.restartingApp.set(true);
    try {
      await this.debugService.restartApp();
    } catch (error) {
      console.error('Failed to restart app:', error);
      this.notificationService.showError(this.translate.instant('updates.restartFailed'));
    } finally {
      this.restartingApp.set(false);
    }
  }

  async skipUpdate(): Promise<void> {
    const update = this.appUpdateAvailable();
    if (!update) return;
    await this.appUpdaterService.skipVersion(update.version);
  }

  async unskipVersion(version: string): Promise<void> {
    // Note: no loading state needed — the button has no disabled binding.
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
      await this.appUpdaterService.setAutoCheckEnabled(!this.appAutoCheckUpdates());
    } catch (error) {
      console.error('Failed to toggle auto-check:', error);
      this.notificationService.showError(
        this.translate.instant('modals.about.updateSettingFailed')
      );
    }
  }

  async changeChannel(channel: string): Promise<void> {
    await this.appUpdaterService.setChannel(channel);
  }

  // ---------------------------------------------------------------------------
  // Rclone updater actions
  // ---------------------------------------------------------------------------

  async checkForRcloneUpdates(): Promise<void> {
    if (this.rcloneUpdateStatus().checking) return;
    await this.rcloneUpdateService.checkForUpdates();
  }

  async installRcloneUpdate(): Promise<void> {
    if (this.rcloneUpdateStatus().downloading) return;
    await this.rcloneUpdateService.performUpdate();
  }

  async applyRcloneUpdate(): Promise<void> {
    if (!this.rcloneUpdateStatus().readyToRestart || this.restartingRcloneEngine()) return;
    this.restartingRcloneEngine.set(true);
    try {
      await this.rcloneUpdateService.applyUpdate();
    } finally {
      this.restartingRcloneEngine.set(false);
    }
  }

  async skipRcloneUpdate(): Promise<void> {
    const info = this.rcloneUpdateStatus().updateInfo;
    if (!info) return;
    await this.rcloneUpdateService.skipVersion(info.latest_version_clean ?? info.latest_version);
  }

  async unskipRcloneVersion(version: string): Promise<void> {
    await this.rcloneUpdateService.unskipVersion(version);
  }

  async toggleRcloneAutoCheck(): Promise<void> {
    try {
      await this.rcloneUpdateService.setAutoCheckEnabled(!this.rcloneAutoCheck());
    } catch (error) {
      console.error('Failed to toggle rclone auto-check:', error);
      this.notificationService.showError(
        this.translate.instant('modals.about.updateSettingFailed')
      );
    }
  }

  async changeRcloneChannel(channel: string): Promise<void> {
    await this.rcloneUpdateService.setChannel(channel);
  }

  // ---------------------------------------------------------------------------
  // Platform / engine actions
  // ---------------------------------------------------------------------------

  getUpdateInstructions(): {
    command?: string;
    links: { label: string; url: string; primary?: boolean }[];
  } | null {
    const website = 'https://hakanismail.info/zarestia/rclone-manager/downloads';

    switch (this.buildType()) {
      case 'flatpak':
        return {
          command: 'flatpak update io.github.zarestia_dev.rclone-manager',
          links: [
            {
              label: 'modals.about.openFlathub',
              url: 'https://flathub.org/apps/io.github.zarestia_dev.rclone-manager',
              primary: true,
            },
          ],
        };
      case 'arch':
        return {
          command: 'yay -Syu rclone-manager',
          links: [
            {
              label: 'modals.about.downloadPage',
              url: 'https://aur.archlinux.org/packages/rclone-manager',
              primary: true,
            },
          ],
        };
      case 'deb':
        return {
          links: [{ label: 'modals.about.downloadPage', url: website, primary: true }],
        };
      case 'rpm':
        return {
          links: [{ label: 'modals.about.downloadPage', url: website, primary: true }],
        };
      case 'portable':
        return {
          links: [{ label: 'modals.about.downloadPage', url: website, primary: true }],
        };
      case 'container':
        return {
          command: 'docker pull ghcr.io/zarestia-dev/rclone-manager:latest',
          links: [{ label: 'modals.about.downloadPage', url: website, primary: true }],
        };
      default:
        return null;
    }
  }

  async quitRcloneEngine(): Promise<void> {
    try {
      if (this.backendService.activeBackend() === 'Local') {
        const pid = this.rcloneStatusService.rclonePID();
        if (!pid) {
          this.notificationService.showInfo(this.translate.instant('modals.about.noProcessToKill'));
          return;
        }
        await this.systemInfoService.killProcess(pid);
      } else {
        await this.systemInfoService.quitRcloneEngine();
      }
      this.notificationService.showSuccess(this.translate.instant('modals.about.killSuccess'));
      await this.rcloneStatusService.refresh();
    } catch (error) {
      console.error('Failed to quit rclone engine:', error);
      this.notificationService.showError(this.translate.instant('modals.about.killFailed'));
    }
  }

  async runGarbageCollector(): Promise<void> {
    if (this.runningGc()) return;
    this.runningGc.set(true);
    try {
      await this.systemInfoService.runGarbageCollector();
      this.notificationService.showSuccess(this.translate.instant('modals.about.gcSuccess'));
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
      this.fsCacheEntries.set(await this.systemInfoService.getFsCacheEntries());
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

  // ---------------------------------------------------------------------------
  // UI helpers
  // ---------------------------------------------------------------------------

  onScroll(content: HTMLElement): void {
    this.scrolled.set(content.scrollTop > 10);
  }

  onLogoClick(): void {
    const count = this.logoClickCount() + 1;
    this.logoClickCount.set(count);

    if (this.logoClickTimeout) clearTimeout(this.logoClickTimeout);

    if (count >= 5) {
      this.logoClickCount.set(0);
      this.showDebugOverlay();
      return;
    }

    this.logoClickTimeout = setTimeout(() => this.logoClickCount.set(0), 2000);
  }

  async showDebugOverlay(): Promise<void> {
    this.navigateTo('debug');
    try {
      this.debugInfo.set(await this.debugService.getDebugInfo());
    } catch (error) {
      console.error('Failed to load debug info:', error);
    }
  }

  showMemoryOverlay(): void {
    this.navigateTo('memory');
  }

  async openFolder(folderType: 'logs' | 'config' | 'cache'): Promise<void> {
    await this.debugService.openFolder(folderType);
  }

  async openDevTools(): Promise<void> {
    await this.debugService.openDevTools();
  }

  formatReleaseDate(dateString: string): string {
    try {
      return new Date(dateString).toLocaleDateString(this.translate.getCurrentLang(), {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    } catch {
      return dateString;
    }
  }

  getChannelLabel(channel: string | null | undefined): string {
    if (!channel) return '';
    return this.channels.find(c => c.value === channel)?.label ?? channel;
  }

  private formatReleaseNotes(markdown: string | undefined | null): SafeHtml {
    if (!markdown) {
      return this.sanitizer.bypassSecurityTrustHtml(
        `<p>${this.translate.instant('modals.about.noReleaseNotes')}</p>`
      );
    }
    const html = marked.parse(markdown, { gfm: true, breaks: true, renderer }) as string;
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }
}
