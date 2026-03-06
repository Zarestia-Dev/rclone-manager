import {
  Component,
  HostListener,
  OnInit,
  computed,
  inject,
  signal,
  DestroyRef,
  ChangeDetectionStrategy,
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
import { NgTemplateOutlet, CommonModule } from '@angular/common';

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
    CommonModule,
  ],
  templateUrl: './about-modal.component.html',
  styleUrls: ['./about-modal.component.scss', '../../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AboutModalComponent implements OnInit {
  readonly rCloneManagerVersion = appVersion;

  private dialogRef = inject(MatDialogRef<AboutModalComponent>);
  private systemInfoService = inject(SystemInfoService);
  private notificationService = inject(NotificationService);
  private destroyRef = inject(DestroyRef);
  protected appUpdaterService = inject(AppUpdaterService);
  protected rcloneUpdateService = inject(RcloneUpdateService);
  private debugService = inject(DebugService);
  private sanitizer = inject(DomSanitizer);
  private translate = inject(TranslateService);

  readonly rcloneStatusService = inject(RcloneStatusService);
  readonly backendService = inject(BackendService);
  readonly modalService = inject(ModalService);

  // -------------------------------------------------------------------------
  // Navigation state
  // -------------------------------------------------------------------------

  readonly overlayStack = signal<OverlayView[]>([]);
  readonly scrolled = signal<boolean>(false);

  readonly isOverlayOpen = computed(() => this.overlayStack().length > 0);
  readonly currentView = computed(() => {
    const stack = this.overlayStack();
    return stack.length > 0 ? stack[stack.length - 1] : { id: 'main' as const };
  });

  // -------------------------------------------------------------------------
  // App updater signals
  // -------------------------------------------------------------------------

  readonly appAutoCheckUpdates = signal<boolean>(true);
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

  // -------------------------------------------------------------------------
  // Rclone updater signals
  // -------------------------------------------------------------------------

  readonly rcloneUpdateStatus = this.rcloneUpdateService.updateStatus;
  readonly rcloneUpdateChannel = this.rcloneUpdateService.updateChannel;
  readonly rcloneSkippedVersions = this.rcloneUpdateService.skippedVersions;
  // Read directly from the service — no need for a local copy kept in sync via effect()
  readonly rcloneAutoCheck = this.rcloneUpdateService.autoCheck;

  readonly restartingApp = signal<boolean>(false);
  readonly restartingRcloneEngine = signal<boolean>(false);
  readonly checkingForUpdates = signal<boolean>(false);

  // -------------------------------------------------------------------------
  // Rclone info
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Platform / fscache
  // -------------------------------------------------------------------------

  readonly buildType = signal<string | null>(null);
  readonly updatesDisabled = signal<boolean>(false);
  readonly fsCacheEntries = signal<number>(0);
  readonly clearingFsCache = signal<boolean>(false);

  // -------------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------------

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

  // Badge for the "About Rclone" nav item — true when there is any pending
  // rclone action (update available OR binary staged and ready to apply).
  readonly rcloneNavBadge = computed(() => {
    const s = this.rcloneUpdateStatus();
    return s.available || s.readyToRestart;
  });

  // -------------------------------------------------------------------------
  // Easter egg / misc
  // -------------------------------------------------------------------------

  protected logoClickCount = 0;
  private logoClickTimeout: ReturnType<typeof setTimeout> | null = null;

  readonly debugInfo = signal<DebugInfo | null>(null);

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async ngOnInit(): Promise<void> {
    await this.loadPlatformInfo();
    this.loadAppAutoCheckSetting();
    this.loadFsCacheEntries();
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  navigateTo(viewId: ViewId): void {
    this.overlayStack.update(stack => [...stack, { id: viewId }]);
  }

  goBack(): void {
    this.overlayStack.update(stack => stack.slice(0, -1));
  }

  showWhatsNew(type: 'app' | 'rclone'): void {
    this.navigateTo(type === 'app' ? 'whats-new-app' : 'whats-new-rclone');
  }

  @HostListener('document:keydown.escape')
  close(): void {
    if (this.overlayStack().length > 0) {
      this.goBack();
    } else {
      this.modalService.animatedClose(this.dialogRef);
    }
  }

  getPageTitle(viewId?: ViewId): string {
    const id = viewId ?? this.currentView().id;
    const titleMap: Partial<Record<ViewId | 'main', string>> = {
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
    const key = titleMap[id];
    return key ? this.translate.instant(key) : '';
  }

  // -------------------------------------------------------------------------
  // App updater actions
  // -------------------------------------------------------------------------

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
    this.checkingForUpdates.set(true);
    try {
      await this.appUpdaterService.unskipVersion(version);
      this.notificationService.showSuccess(this.translate.instant('updates.restored', { version }));
    } catch (error) {
      console.error('Failed to unskip version:', error);
      this.notificationService.showError(this.translate.instant('updates.restoreFailed'));
    } finally {
      this.checkingForUpdates.set(false);
    }
  }

  async toggleAutoCheck(): Promise<void> {
    const current = this.appAutoCheckUpdates();
    this.appAutoCheckUpdates.set(!current);
    try {
      await this.appUpdaterService.setAutoCheckEnabled(!current);
      this.notificationService.showSuccess(
        this.translate.instant(
          !current ? 'modals.about.autoCheckEnabled' : 'modals.about.autoCheckDisabled'
        )
      );
    } catch (error) {
      console.error('Failed to toggle auto-check:', error);
      this.notificationService.showError(
        this.translate.instant('modals.about.updateSettingFailed')
      );
      this.appAutoCheckUpdates.set(current); // revert
    }
  }

  async changeChannel(channel: string): Promise<void> {
    await this.appUpdaterService.setChannel(channel);
  }

  private async loadAppAutoCheckSetting(): Promise<void> {
    try {
      this.appAutoCheckUpdates.set(await this.appUpdaterService.getAutoCheckEnabled());
    } catch (error) {
      console.error('Failed to load auto-check setting:', error);
    }
  }

  // -------------------------------------------------------------------------
  // Rclone updater actions
  // -------------------------------------------------------------------------

  async checkForRcloneUpdates(): Promise<void> {
    if (this.rcloneUpdateStatus().checking) return;
    await this.rcloneUpdateService.checkForUpdates();
  }

  async installRcloneUpdate(): Promise<void> {
    if (this.rcloneUpdateStatus().updating) return;
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
    const current = this.rcloneAutoCheck();
    try {
      await this.rcloneUpdateService.setAutoCheckEnabled(!current);
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

  // -------------------------------------------------------------------------
  // Platform / engine actions
  // -------------------------------------------------------------------------

  private async loadPlatformInfo(): Promise<void> {
    try {
      const [type, disabled] = await Promise.all([
        this.systemInfoService.getBuildType(),
        this.systemInfoService.areUpdatesDisabled(),
      ]);
      this.buildType.set(type);
      this.updatesDisabled.set(disabled);
    } catch (error) {
      console.error('Failed to load platform info:', error);
    }
  }

  async quitRcloneEngine(): Promise<void> {
    try {
      if (this.backendService.activeBackend() === 'Local') {
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

  // -------------------------------------------------------------------------
  // UI helpers
  // -------------------------------------------------------------------------

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

  copyToClipboard(text: string): void {
    navigator.clipboard.writeText(text).then(
      () =>
        this.notificationService.openSnackBar(
          this.translate.instant('modals.about.copied'),
          this.translate.instant('common.close')
        ),
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
      return new Date(dateString).toLocaleDateString(this.translate.getCurrentLang(), {
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
      return this.sanitizer.bypassSecurityTrustHtml(
        `<p>${this.translate.instant('modals.about.noReleaseNotes')}</p>`
      );
    }
    const html = marked.parse(markdown, { gfm: true, breaks: true, renderer }) as string;
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }

  getChannelLabel(channel: string | null | undefined): string {
    if (!channel) return '';
    return this.channels.find(c => c.value === channel)?.label ?? channel;
  }
}
