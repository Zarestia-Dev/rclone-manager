import {
  Component,
  OnInit,
  computed,
  inject,
  signal,
  Signal,
  ChangeDetectionStrategy,
  SecurityContext,
} from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { version as appVersion } from '../../../../../../package.json';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatBadgeModule } from '@angular/material/badge';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { FormatFileSizePipe, FormatRelativeDatePipe, FormatNumberPipe } from '@app/pipes';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked, Renderer } from 'marked';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { NgTemplateOutlet } from '@angular/common';

import { SystemInfoService } from 'src/app/services/infrastructure/system/system-info.service';
import { AppUpdaterService } from 'src/app/services/infrastructure/maintenance/app-updater.service';
import { RcloneUpdateService } from 'src/app/services/infrastructure/maintenance/rclone-update.service';
import { DebugService, DebugInfo } from 'src/app/services/infrastructure/system/debug.service';
import { AppLifecycleService } from 'src/app/services/infrastructure/system/app-lifecycle.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { RcloneStatusService } from 'src/app/services/infrastructure/maintenance/rclone-status.service';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import { BackendTranslationService } from 'src/app/services/i18n/backend-translation.service';
import { ViewId, OverlayView, PillTone, UpdateMetadata } from '@app/types';
import { UpdateChannel } from 'src/app/services/infrastructure/maintenance/update-settings-manager';
import { CopyToClipboardDirective } from '../../../../shared/directives/copy-to-clipboard.directive';
import { AlertBannerComponent } from '../../../../shared/components/alert-banner/alert-banner.component';
import {
  isServerMode,
  isMobile,
} from 'src/app/services/infrastructure/platform/api-client.service';

import { PillDirective } from '../../../../shared/directives/pill.directive';

type UpdateTarget = 'app' | 'rclone';

/** Installation kinds the about page names, with the tone of their pill. */
const PLATFORMS: Record<string, { label: string; tone: PillTone }> = {
  deb: { label: 'DEB', tone: 'warn' },
  rpm: { label: 'RPM', tone: 'orange' },
  pacman: { label: 'Pacman', tone: 'accent' },
  flatpak: { label: 'Flatpak', tone: 'accent' },
  portable: { label: 'Portable', tone: 'accent' },
  container: { label: 'Docker', tone: 'accent' },
};

/** rclone's changelog is a page of rclone.org, so its links (`/dosya/`, `#anchor`) are relative to it. */
const RCLONE_CHANGELOG_URL = 'https://rclone.org/changelog/';

// Configure renderer once at module level
const renderer = new Renderer();
renderer.link = ({ href, title, text }): string => {
  const titleAttr = title ? ` title="${title}"` : '';
  return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
};

@Component({
  selector: 'app-about-modal',
  imports: [
    FormatNumberPipe,
    NgTemplateOutlet,
    MatDividerModule,
    MatIconModule,
    MatButtonModule,
    MatSlideToggleModule,
    MatBadgeModule,
    MatProgressBarModule,
    FormatFileSizePipe,
    FormatRelativeDatePipe,
    TranslatePipe,
    CopyToClipboardDirective,
    AlertBannerComponent,
    PillDirective,
  ],
  templateUrl: './about-modal.component.html',
  styleUrls: ['./about-modal.component.scss', '../../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'close()' },
})
export class AboutModalComponent implements OnInit {
  readonly rCloneManagerVersion = appVersion;
  /** Pre-release builds carry a suffix such as `-beta.4`. */
  readonly isPrereleaseBuild = appVersion.includes('-');

  private readonly dialogRef = inject(MatDialogRef<AboutModalComponent>);
  private readonly systemInfoService = inject(SystemInfoService);
  private readonly notificationService = inject(NotificationService);
  protected readonly appUpdater = inject(AppUpdaterService);
  protected readonly rcloneUpdater = inject(RcloneUpdateService);
  private readonly debugService = inject(DebugService);
  private readonly appLifecycle = inject(AppLifecycleService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly translate = inject(TranslateService);
  private readonly backendTranslation = inject(BackendTranslationService);

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

  readonly restartingApp = signal(false);
  readonly restartingRcloneEngine = signal(false);

  readonly isServer = isServerMode();
  /** The OS owns a native mobile app's process, so it can neither restart itself nor open DevTools. */
  readonly isNativeMobile = !this.isServer && isMobile();

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

  readonly buildType = this.appUpdater.buildType;
  readonly fsCacheEntries = signal(0);
  readonly clearingFsCache = signal(false);
  readonly isLibrclone = signal(false);

  // ---------------------------------------------------------------------------
  // Debug
  // ---------------------------------------------------------------------------

  readonly debugInfo = signal<DebugInfo | null>(null);

  // ---------------------------------------------------------------------------
  // Release notes view
  // ---------------------------------------------------------------------------

  /** The release the notes view shows; null while the installed one loads. */
  readonly shownRelease = signal<UpdateMetadata | null>(null);
  /** Whose notes the view shows; the links of rclone's notes are relative to rclone.org. */
  private readonly shownTarget = signal<UpdateTarget>('app');
  readonly releaseNotesError = signal('');
  private releaseNotesRequest = 0;

  readonly formattedReleaseNotes = computed(() =>
    this.formatReleaseNotes(
      this.shownRelease()?.releaseNotes,
      this.shownTarget() === 'rclone' ? RCLONE_CHANGELOG_URL : undefined
    )
  );

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  readonly channels: {
    value: UpdateChannel;
    label: string;
    description: string;
    tone: PillTone;
  }[] = [
    {
      value: 'stable',
      label: 'modals.about.channelStable',
      description: 'modals.about.channelStableDesc',
      tone: 'primary',
    },
    {
      value: 'beta',
      label: 'modals.about.channelBeta',
      description: 'modals.about.channelBetaDesc',
      tone: 'orange',
    },
  ];

  readonly navItems: { label: string; viewId: ViewId; badge?: Signal<boolean> }[] = [
    { label: 'modals.about.details', viewId: 'details' },
    {
      label: 'modals.about.aboutRclone',
      viewId: 'about-rclone',
      badge: computed(() => this.rcloneUpdater.hasUpdates() || this.rcloneUpdater.readyToRestart()),
    },
    {
      label: 'modals.about.aboutApp',
      viewId: 'about-app',
      badge: computed(
        () => !!this.appUpdater.updateAvailable() || this.appUpdater.readyToRestart()
      ),
    },
  ];

  readonly bottomNavItems: { label: string; viewId: ViewId }[] = [
    { label: 'modals.about.credits', viewId: 'credits' },
    { label: 'modals.about.legal', viewId: 'legal' },
  ];

  readonly contributors = [
    { name: 'ふぁんなんよ', github: 'fuannanyo' },
    { name: 'Eduardo Mozart de Oliveira', github: 'eduardomozart' },
    { name: 'korsun009', github: 'korsun009' },
    { name: 'Willi Yang (YangLeDuo)', github: 'why25' },
    { name: 'Gh0sti', github: 'gh0sti' },
    { name: 'dikler', github: 'dikler' },
    { name: 'maksam07', github: 'maksam07' },
    { name: 'DraftingDreamer', github: 'DraftingDreamer' },
    { name: 'nvdx', github: 'nvandamme' },
    { name: 'powerAn', github: 'powerAn2020' },
    { name: 'VAIO73', github: 'Vaso73' },
    { name: 'Renato Pires', github: 'repires' },
  ] as const;

  readonly pageTitles: Record<ViewId, string> = {
    details: 'modals.about.details',
    'about-app': 'modals.about.aboutApp',
    'about-rclone': 'modals.about.aboutRclone',
    'app-update-settings': 'modals.about.updateSettings',
    'rclone-update-settings': 'modals.about.rcloneUpdateSettings',
    credits: 'modals.about.credits',
    legal: 'modals.about.legal',
    'release-notes': 'modals.about.whatsNew',
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
    try {
      this.isLibrclone.set(await this.systemInfoService.isLibrclone());
    } catch (error) {
      console.error('Failed to check librclone mode:', error);
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

  showReleaseNotes(release: UpdateMetadata, target: UpdateTarget): void {
    ++this.releaseNotesRequest;
    this.shownTarget.set(target);
    this.shownRelease.set(release);
    this.releaseNotesError.set('');
    this.navigateTo('release-notes');
  }

  /** Shows the notes of the installed version, which only GitHub has. */
  async showInstalledReleaseNotes(target: UpdateTarget): Promise<void> {
    const request = ++this.releaseNotesRequest;
    this.shownTarget.set(target);
    this.shownRelease.set(null);
    this.releaseNotesError.set('');
    this.navigateTo('release-notes');
    try {
      const release =
        target === 'app'
          ? await this.appUpdater.installedRelease()
          : await this.rcloneUpdater.installedRelease(this.rcloneInfo()?.version ?? '');
      if (request === this.releaseNotesRequest) this.shownRelease.set(release);
    } catch (error) {
      if (request !== this.releaseNotesRequest) return;
      console.error('Failed to load release notes:', error);
      this.releaseNotesError.set(
        this.backendTranslation.translateBackendMessage(error) ||
          this.translate.instant('common.error')
      );
    }
  }

  close(): void {
    if (this.overlayStack().length > 0) {
      this.goBack();
    } else {
      this.dialogRef.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Updater actions
  // ---------------------------------------------------------------------------

  /** The updater a shared template section acts on. */
  updater(target: UpdateTarget): AppUpdaterService | RcloneUpdateService {
    return target === 'app' ? this.appUpdater : this.rcloneUpdater;
  }

  async finishUpdate(): Promise<void> {
    if (this.restartingApp()) return;
    this.restartingApp.set(true);
    try {
      // The service reports failures itself.
      await this.appUpdater.finishUpdate();
    } finally {
      this.restartingApp.set(false);
    }
  }

  async restartApp(): Promise<void> {
    if (this.restartingApp()) return;
    this.restartingApp.set(true);
    try {
      await this.appLifecycle.relaunchApp();
    } catch (error) {
      console.error('Failed to restart app:', error);
      const translated = this.backendTranslation.translateBackendMessage(error);
      this.notificationService.showError(
        this.translate.instant('updates.restartFailed', {
          error: translated || this.translate.instant('common.error'),
        })
      );
    } finally {
      this.restartingApp.set(false);
    }
  }

  async applyRcloneUpdate(): Promise<void> {
    if (!this.rcloneUpdater.readyToRestart() || this.restartingRcloneEngine()) return;
    this.restartingRcloneEngine.set(true);
    try {
      // The service reports failures itself.
      await this.rcloneUpdater.applyUpdate();
    } finally {
      this.restartingRcloneEngine.set(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Platform / engine actions
  // ---------------------------------------------------------------------------

  readonly updateInstructions = computed(() => {
    if (this.appUpdater.canAutoInstall()) return null;
    const website = 'https://hakanismail.info/zarestia/rclone-manager/downloads';
    // The backend builds the command for the detected installation (AUR helper, Flatpak ID).
    const command = this.appUpdater.installationCommand() || undefined;
    switch (this.buildType()) {
      case 'pacman': {
        const pkg = this.appUpdater.installationPackage();
        const url = pkg
          ? `https://aur.archlinux.org/packages/${encodeURIComponent(pkg)}`
          : 'https://aur.archlinux.org/packages?K=rclone-manager';
        return { command, links: [{ label: 'modals.about.openAur', url }] };
      }
      case 'flatpak':
        return {
          command,
          links: [
            {
              label: 'modals.about.openFlathub',
              url: 'https://flathub.org/apps/io.github.zarestia_dev.rclone-manager',
            },
          ],
        };
      case 'portable':
      case 'container':
        return { command, links: [{ label: 'modals.about.downloadPage', url: website }] };
      default:
        return {
          command,
          links: [
            {
              label: 'modals.about.viewOnGithub',
              url:
                this.appUpdater.updateAvailable()?.releaseUrl ||
                'https://github.com/Zarestia-Dev/rclone-manager/releases/latest',
            },
          ],
        };
    }
  });

  async quitRcloneEngine(): Promise<void> {
    if (this.isLibrclone()) {
      return;
    }
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

  async openFolder(folderType: 'logs' | 'config' | 'cache'): Promise<void> {
    await this.debugService.openFolder(folderType);
  }

  async openDevTools(): Promise<void> {
    await this.debugService.openDevTools();
  }

  formatReleaseDate(dateString: string): string {
    return new Date(dateString).toLocaleDateString(this.translate.getCurrentLang() ?? 'en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  getPlatform(buildType: string): { label: string; tone: PillTone } {
    return PLATFORMS[buildType] ?? { label: buildType.toUpperCase(), tone: 'accent' };
  }

  private formatReleaseNotes(markdown: string | undefined | null, linkBase?: string): SafeHtml {
    if (!markdown) {
      return this.sanitizer.bypassSecurityTrustHtml(
        `<p>${this.translate.instant('modals.about.noReleaseNotes')}</p>`
      );
    }
    const rawHtml = marked.parse(markdown, {
      gfm: true,
      breaks: true,
      renderer,
      walkTokens: token => {
        if (linkBase && token.type === 'link' && /^[/#]/.test(token.href)) {
          token.href = new URL(token.href, linkBase).href;
        }
      },
    }) as string;
    const sanitizedHtml = this.sanitizer.sanitize(SecurityContext.HTML, rawHtml) ?? '';
    return this.sanitizer.bypassSecurityTrustHtml(sanitizedHtml);
  }
}
