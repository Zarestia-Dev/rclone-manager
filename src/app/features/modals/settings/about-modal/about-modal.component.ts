import {
  Component,
  OnInit,
  computed,
  inject,
  signal,
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
import { FormatFileSizePipe } from '@app/pipes';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked, Renderer } from 'marked';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NgClass, NgTemplateOutlet, DecimalPipe } from '@angular/common';

import { SystemInfoService } from 'src/app/services/infrastructure/system/system-info.service';
import { AppUpdaterService } from 'src/app/services/infrastructure/maintenance/app-updater.service';
import { RcloneUpdateService } from 'src/app/services/infrastructure/maintenance/rclone-update.service';
import { DebugService, DebugInfo } from 'src/app/services/infrastructure/system/debug.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { RcloneStatusService } from 'src/app/services/infrastructure/maintenance/rclone-status.service';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import { DownloadStateStatus } from '@app/types';
import { CopyToClipboardDirective } from '../../../../shared/directives/copy-to-clipboard.directive';

// Configure renderer once at module level
const renderer = new Renderer();
renderer.link = ({ href, title, text }): string => {
  const titleAttr = title ? ` title="${title}"` : '';
  return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
};

export type ViewId =
  | 'details'
  | 'about-app'
  | 'about-rclone'
  | 'credits'
  | 'legal'
  | 'whats-new-app'
  | 'whats-new-rclone'
  | 'memory'
  | 'debugging';

export interface OverlayView {
  id: ViewId;
}

@Component({
  selector: 'app-about-modal',
  imports: [
    NgClass,
    DecimalPipe,
    NgTemplateOutlet,
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

  private readonly rcloneStatusService = inject(RcloneStatusService);
  public readonly backendService = inject(BackendService);

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
  readonly appReadyToRestart = this.appUpdaterService.readyToRestart;
  readonly appDownloadStatus = this.appUpdaterService.downloadStatus;
  readonly appIsChecking = this.appUpdaterService.isChecking;

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
    return (
      !!this.appUpdateInProgress() &&
      status?.state.status !== DownloadStateStatus.Complete &&
      status?.state.status !== DownloadStateStatus.Failed
    );
  });

  // ---------------------------------------------------------------------------
  // Rclone updater signals
  // ---------------------------------------------------------------------------

  readonly rcloneUpdateAvailable = this.rcloneUpdateService.updateAvailable;
  readonly rcloneHasUpdates = this.rcloneUpdateService.hasUpdates;
  readonly rcloneUpdateInProgress = this.rcloneUpdateService.downloading;
  readonly rcloneIsChecking = this.rcloneUpdateService.isChecking;
  readonly rcloneReadyToRestart = this.rcloneUpdateService.readyToRestart;
  readonly rcloneUpdateChannel = this.rcloneUpdateService.updateChannel;
  readonly rcloneSkippedVersions = this.rcloneUpdateService.skippedVersions;
  readonly rcloneAutoCheck = this.rcloneUpdateService.autoCheckEnabled;

  readonly restartingApp = signal(false);
  readonly restartingRcloneEngine = signal(false);

  // ---------------------------------------------------------------------------
  // Rclone info
  // ---------------------------------------------------------------------------

  readonly rcloneInfo = computed(() => {
    const info = this.rcloneStatusService.rcloneInfo();
    const pid = this.rcloneStatusService.rclonePID();
    if (!info) return null;
    return { ...info, pid };
  });

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
  readonly updaterEnabled = computed(() => this.appUpdaterService.isUpdaterEnabled());
  readonly fsCacheEntries = signal(0);
  readonly clearingFsCache = signal(false);

  // ---------------------------------------------------------------------------
  // Debug
  // ---------------------------------------------------------------------------

  readonly debugInfo = signal<DebugInfo | null>(null);

  // ---------------------------------------------------------------------------
  // Memoized markdown rendering
  // ---------------------------------------------------------------------------

  readonly formattedAppReleaseNotes = computed(() =>
    this.formatReleaseNotes(this.appUpdateAvailable()?.releaseNotes)
  );

  readonly formattedRcloneReleaseNotes = computed(() =>
    this.formatReleaseNotes(this.rcloneUpdateAvailable()?.releaseNotes)
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
    return this.rcloneHasUpdates() || this.rcloneReadyToRestart();
  });

  // Static lookup — extracted to a field so getPageTitle() doesn't allocate a
  // new object literal on every call.
  private readonly pageTitleMap: Partial<Record<ViewId | 'main', string>> = {
    details: 'modals.about.details',
    'about-app': 'modals.about.aboutApp',
    'about-rclone': 'modals.about.aboutRclone',
    credits: 'modals.about.credits',
    legal: 'modals.about.legal',
    'whats-new-app': 'modals.about.whatsNew',
    'whats-new-rclone': 'modals.about.whatsNew',
    memory: 'modals.about.memoryStats',
    debugging: 'modals.about.debugTools',
  };

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async ngOnInit(): Promise<void> {
    this.loadFsCacheEntries();
    try {
      this.debugInfo.set(await this.debugService.getDebugInfo());
    } catch (error) {
      console.error('Failed to load debug info:', error);
    }
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
      this.dialogRef.close();
    }
  }

  getPageTitle(viewId?: ViewId): string {
    const id = viewId ?? this.currentView().id;
    return this.pageTitleMap[id] ?? '';
  }

  // ---------------------------------------------------------------------------
  // App updater actions
  // ---------------------------------------------------------------------------

  async checkForUpdates(): Promise<void> {
    if (this.appIsChecking()) return;
    await this.appUpdaterService.checkForUpdates();
  }

  async installUpdate(): Promise<void> {
    if (this.appUpdateInProgress()) return;
    await this.appUpdaterService.installUpdate();
  }

  async cancelAppUpdate(): Promise<void> {
    await this.appUpdaterService.cancelUpdate();
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
    if (this.rcloneIsChecking()) return;
    await this.rcloneUpdateService.checkForUpdates();
  }

  async installRcloneUpdate(): Promise<void> {
    if (this.rcloneUpdateInProgress()) return;
    await this.rcloneUpdateService.performUpdate();
  }

  async cancelRcloneUpdate(): Promise<void> {
    await this.rcloneUpdateService.cancelUpdate();
  }

  async applyRcloneUpdate(): Promise<void> {
    if (!this.rcloneReadyToRestart() || this.restartingRcloneEngine()) return;
    this.restartingRcloneEngine.set(true);
    try {
      await this.rcloneUpdateService.applyUpdate();
    } finally {
      this.restartingRcloneEngine.set(false);
    }
  }

  async skipRcloneUpdate(): Promise<void> {
    const info = this.rcloneUpdateAvailable();
    if (!info) return;
    await this.rcloneUpdateService.skipVersion(info.version);
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

  readonly updateInstructions = computed(() => {
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
  });

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
      await this.rcloneStatusService.refreshStatus();
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
      await this.rcloneStatusService.refreshStatus();
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
