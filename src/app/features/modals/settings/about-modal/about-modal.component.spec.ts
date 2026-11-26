import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { axeViolations } from 'src/testing/axe';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { signal, WritableSignal } from '@angular/core';
import { AboutModalComponent } from './about-modal.component';
import { BackendUpdateStatus, UpdateInfo } from '@app/types';
import { SystemInfoService } from 'src/app/services/infrastructure/system/system-info.service';
import { AppUpdaterService } from 'src/app/services/infrastructure/maintenance/app-updater.service';
import { RcloneUpdateService } from 'src/app/services/infrastructure/maintenance/rclone-update.service';
import { DebugService } from 'src/app/services/infrastructure/system/debug.service';
import { AppLifecycleService } from 'src/app/services/infrastructure/system/app-lifecycle.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { RcloneStatusService } from 'src/app/services/infrastructure/maintenance/rclone-status.service';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import { BackendTranslationService } from 'src/app/services/i18n/backend-translation.service';

describe('AboutModalComponent', () => {
  let fixture: ComponentFixture<AboutModalComponent>;
  let component: AboutModalComponent;
  let dialogRefSpy: { close: ReturnType<typeof vi.fn> };

  let buildType: WritableSignal<string | null>;
  let canAutoInstall: WritableSignal<boolean>;
  let readyToRestart: WritableSignal<boolean>;
  let installationFailure: WritableSignal<string>;
  let installationCommand: WritableSignal<string>;
  let installationPackage: WritableSignal<string>;
  let updateAvailable: WritableSignal<UpdateInfo | null>;
  let lastCheckedAt: WritableSignal<string | null>;
  let checkError: WritableSignal<string>;
  let autoCheckEnabled: WritableSignal<boolean>;
  let skippedVersions: WritableSignal<string[]>;
  const cancelUpdate = vi.fn();
  const setChannel = vi.fn();
  const relaunchApp = vi.fn();
  const installedRelease = vi.fn();

  beforeEach(async () => {
    buildType = signal<string | null>(null);
    canAutoInstall = signal(true);
    readyToRestart = signal(false);
    installationFailure = signal('');
    installationCommand = signal('');
    installationPackage = signal('');
    updateAvailable = signal<UpdateInfo | null>(null);
    lastCheckedAt = signal<string | null>(null);
    checkError = signal('');
    autoCheckEnabled = signal(true);
    skippedVersions = signal<string[]>([]);
    installedRelease.mockReset();
    setChannel.mockReset();
    cancelUpdate.mockReset().mockResolvedValue(undefined);
    relaunchApp.mockReset().mockResolvedValue(undefined);
    dialogRefSpy = { close: vi.fn() };

    const mockSystemInfoService = {
      isLibrclone: vi.fn().mockResolvedValue(false),
    };

    const mockAppUpdaterService = {
      autoCheckEnabled,
      updateAvailable,
      updateInProgress: signal(false),
      downloading: signal(false),
      updateChannel: signal('stable'),
      setChannel,
      skippedVersions,
      readyToRestart,
      isCancelling: signal(false),
      cancelUpdate,
      downloadStatus: signal(null),
      isChecking: signal(false),
      buildType,
      canAutoInstall,
      installationReason: signal(''),
      installationFailure,
      installationCommand,
      installationPackage,
      lastCheckedAt,
      checkError,
      installedRelease,
    };

    const mockRcloneUpdateService = {
      updateAvailable: signal(null),
      hasUpdates: signal(false),
      isCancelling: signal(false),
      downloading: signal(false),
      isChecking: signal(false),
      readyToRestart: signal(false),
      updateChannel: signal('stable'),
      skippedVersions: signal([]),
      autoCheckEnabled: signal(true),
      isUpdaterEnabled: signal(true),
      lastCheckedAt: signal(null),
      error: signal(''),
      notice: signal(''),
    };

    const mockDebugService = {
      getDebugInfo: vi.fn().mockResolvedValue({
        platform: 'linux',
        arch: 'x64',
        mode: 'desktop',
        logsDir: '/tmp/logs',
        configDir: '/tmp/config',
        cacheDir: '/tmp/cache',
      }),
    };

    const mockNotificationService = {
      showError: vi.fn(),
      showSuccess: vi.fn(),
    };

    const mockRcloneStatusService = {
      rcloneInfo: signal(null),
      rclonePID: signal(null),
      isLoading: signal(false),
      rcloneStatus: signal('ok'),
      memoryUsage: signal(null),
    };

    const mockBackendService = {
      activeBackend: signal('Local'),
      rcClient: {
        execute: vi.fn().mockResolvedValue({}),
      },
    };

    const mockBackendTranslationService = {
      translateBackendMessage: vi.fn().mockReturnValue(''),
    };

    await TestBed.configureTestingModule({
      imports: [AboutModalComponent],
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: dialogRefSpy },
        { provide: SystemInfoService, useValue: mockSystemInfoService },
        { provide: AppUpdaterService, useValue: mockAppUpdaterService },
        { provide: RcloneUpdateService, useValue: mockRcloneUpdateService },
        { provide: DebugService, useValue: mockDebugService },
        { provide: AppLifecycleService, useValue: { relaunchApp } },
        { provide: NotificationService, useValue: mockNotificationService },
        { provide: RcloneStatusService, useValue: mockRcloneStatusService },
        { provide: BackendService, useValue: mockBackendService },
        { provide: BackendTranslationService, useValue: mockBackendTranslationService },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AboutModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => vi.restoreAllMocks());

  it('prevents duplicate restarts while relaunch is pending', async () => {
    let resolve!: () => void;
    relaunchApp.mockReturnValue(new Promise<void>(done => (resolve = done)));
    const restarting = component.restartApp();
    expect(component.restartingApp()).toBe(true);
    await component.restartApp();
    expect(relaunchApp).toHaveBeenCalledOnce();
    resolve();
    await restarting;
    expect(component.restartingApp()).toBe(false);
  });

  it('reports restart failures and allows another attempt', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    relaunchApp.mockRejectedValueOnce(new Error('restart failed'));
    await component.restartApp();
    expect(TestBed.inject(NotificationService).showError).toHaveBeenCalled();
    expect(component.restartingApp()).toBe(false);
    await component.restartApp();
    expect(relaunchApp).toHaveBeenCalledTimes(2);
    expect(component.restartingApp()).toBe(false);
  });

  it.each(['flatpak', 'portable', 'container', null])(
    'uses the installation capability rather than the %s label for automatic updates',
    type => {
      buildType.set(type);
      canAutoInstall.set(true);
      expect(component.updateInstructions()).toBeNull();
    }
  );

  it.each(['flatpak', 'container', 'pacman'])(
    'shows the command the backend built for %s installations',
    type => {
      buildType.set(type);
      canAutoInstall.set(false);
      installationCommand.set('update it');
      expect(component.updateInstructions()?.command).toBe('update it');
    }
  );

  it('directs AUR installations to their own package page', () => {
    buildType.set('pacman');
    canAutoInstall.set(false);
    expect(component.updateInstructions()?.links[0].url).toBe(
      'https://aur.archlinux.org/packages?K=rclone-manager'
    );
    expect(component.updateInstructions()?.command).toBeUndefined();
    installationPackage.set('rclone-manager-headless');
    expect(component.updateInstructions()?.links[0].url).toBe(
      'https://aur.archlinux.org/packages/rclone-manager-headless'
    );
    expect(component.getPlatform('pacman').label).toBe('Pacman');
  });

  it('marks an offered update as beta by its pre-release flag rather than its tag text', () => {
    const update: UpdateInfo = {
      version: '1.2.0-rc.1',
      currentVersion: '1.1.0',
      updateAvailable: true,
      status: BackendUpdateStatus.Available,
      releaseTag: 'v1.2.0-rc.1',
      prerelease: true,
    };
    updateAvailable.set(update);
    component.navigateTo('about-app');
    fixture.detectChanges();
    const pill = (): Element | null =>
      (fixture.nativeElement as HTMLElement).querySelector(
        '.update-card[data-tone="accent"] .new-version .app-pill'
      );
    expect(pill()?.textContent).toContain('modals.about.channelBeta');
    updateAvailable.set({ ...update, prerelease: false, releaseTag: 'v1.2.0-beta-notes' });
    fixture.detectChanges();
    expect(pill()).toBeNull();
  });

  it('says up to date only after a check that succeeded', () => {
    component.navigateTo('about-app');
    const title = (): string | undefined => {
      fixture.detectChanges();
      return (fixture.nativeElement as HTMLElement)
        .querySelector('.update-card h4')
        ?.textContent?.trim();
    };
    expect(title()).toBe('modals.about.statusUnknown');
    lastCheckedAt.set('2026-11-24T12:00:00Z');
    expect(title()).toBe('modals.about.upToDate');
    checkError.set('rate limited');
    expect(title()).toBe('modals.about.statusUnknown');
  });

  it('shows the notes of the installed version and drops an answer that arrives too late', async () => {
    let resolveFirst!: (value: unknown) => void;
    installedRelease
      .mockReturnValueOnce(new Promise(resolve => (resolveFirst = resolve)))
      .mockResolvedValueOnce({ version: '0.3.7', releaseNotes: '# Second' });
    const first = component.showInstalledReleaseNotes('app');
    expect(component.currentView().id).toBe('release-notes');
    expect(component.shownRelease()).toBeNull();
    await component.showInstalledReleaseNotes('app');
    resolveFirst({ version: '0.3.6', releaseNotes: '# First' });
    await first;
    expect(component.shownRelease()?.version).toBe('0.3.7');
  });

  it('reports a failure to load the installed release notes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const translate = TestBed.inject(BackendTranslationService);
    vi.mocked(translate.translateBackendMessage).mockReturnValueOnce('GitHub API error: 404');
    installedRelease.mockRejectedValueOnce('backendErrors.updater.github');
    await component.showInstalledReleaseNotes('app');
    expect(component.shownRelease()).toBeNull();
    expect(component.releaseNotesError()).toBe('GitHub API error: 404');
  });

  it('provides the download page for portable installations', () => {
    buildType.set('portable');
    canAutoInstall.set(false);
    expect(component.updateInstructions()?.links[0].label).toBe('modals.about.downloadPage');
  });

  it.each([null, '', 'unknown'])('provides generic manual instructions for %s', type => {
    buildType.set(type);
    canAutoInstall.set(false);
    expect(component.updateInstructions()?.command).toBeUndefined();
    expect(component.updateInstructions()?.links[0].label).toBe('modals.about.viewOnGithub');
  });

  it('shows Docker as installation information only when supplied by the backend', () => {
    buildType.set('container');
    fixture.detectChanges();
    const pills = (): NodeListOf<Element> =>
      (fixture.nativeElement as HTMLElement).querySelectorAll('.version-info .app-pill');
    expect(pills()[1]?.textContent).toContain('Docker');
    buildType.set(null);
    fixture.detectChanges();
    expect(pills().length).toBe(1);
  });

  it('lists its pages as plain buttons, not as tabs', async () => {
    const list = (fixture.nativeElement as HTMLElement).querySelector('.about-list') as HTMLElement;
    expect(list.querySelector('[role="tablist"], [role="tab"], [aria-selected]')).toBeNull();
    expect(await axeViolations(list)).toEqual([]);
  });

  it('lists its pages as plain buttons, not as tabs', async () => {
    const list = (fixture.nativeElement as HTMLElement).querySelector('.about-list') as HTMLElement;
    expect(list.querySelector('[role="tablist"], [role="tab"], [aria-selected]')).toBeNull();
    expect(await axeViolations(list)).toEqual([]);
  });

  it('lists its pages as plain buttons, not as tabs', async () => {
    const list = (fixture.nativeElement as HTMLElement).querySelector('.about-list') as HTMLElement;
    expect(list.querySelector('[role="tablist"], [role="tab"], [aria-selected]')).toBeNull();
    expect(await axeViolations(list)).toEqual([]);
  });

  it('should initialize successfully', () => {
    expect(component).toBeTruthy();
    expect(component.rCloneManagerVersion).toBeDefined();
  });

  it('offers a discard action for a staged application update', async () => {
    readyToRestart.set(true);
    component.navigateTo('about-app');
    fixture.detectChanges();
    const buttons = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
        '.update-card[data-tone="warn"] button'
      )
    );
    const discard = buttons.find(button => button.textContent?.includes('updates.discardDownload'));
    expect(discard).toBeDefined();
    discard?.click();
    await fixture.whenStable();
    expect(cancelUpdate).toHaveBeenCalledOnce();
  });

  it('shows installation errors in an alert banner and removes it when cleared', () => {
    component.navigateTo('about-app');
    fixture.detectChanges();
    const view = fixture.nativeElement as HTMLElement;
    expect(view.querySelector('app-alert-banner')).toBeNull();

    const message =
      'The APK must be a newer version of this application signed by the same publisher.';
    installationFailure.set(message);
    fixture.detectChanges();
    const banner = view.querySelector('app-alert-banner');
    expect(banner?.getAttribute('role')).toBe('alert');
    expect(banner?.classList.contains('error')).toBe(true);
    expect(banner?.textContent).toContain(message);
    expect(view.querySelector('.error-entry')).toBeNull();

    installationFailure.set('');
    fixture.detectChanges();
    expect(view.querySelector('app-alert-banner')).toBeNull();
  });

  it('should have contributors list defined with expected entries', () => {
    expect(component.contributors).toBeDefined();
    expect(component.contributors.length).toBeGreaterThan(0);

    const draftingDreamer = component.contributors.find(c => c.github === 'DraftingDreamer');
    expect(draftingDreamer).toBeDefined();
    expect(draftingDreamer?.name).toBe('DraftingDreamer');

    const nvdx = component.contributors.find(c => c.github === 'nvandamme');
    expect(nvdx).toBeDefined();
    expect(nvdx?.name).toBe('nvdx');

    const eduardo = component.contributors.find(c => c.github === 'eduardomozart');
    expect(eduardo).toBeDefined();
  });

  it('should navigate to credits view and render contributors', () => {
    component.navigateTo('credits');
    fixture.detectChanges();

    expect(component.currentView().id).toBe('credits');

    const compiled = fixture.nativeElement as HTMLElement;
    const links = compiled.querySelectorAll<HTMLAnchorElement>('.contributor-link');
    expect(links.length).toBeGreaterThanOrEqual(component.contributors.length + 1);

    const hrefs = Array.from(links).map(l => l.getAttribute('href'));
    expect(hrefs).toContain('https://github.com/DraftingDreamer');
    expect(hrefs).toContain('https://github.com/nvandamme');
    expect(hrefs).toContain('https://github.com/repires');
    expect(hrefs).toContain('https://github.com/Vaso73');
    expect(hrefs).toContain('https://github.com/powerAn2020');
    expect(hrefs).toContain('https://github.com/Hakanbaban53');
  });

  it('should close dialog or go back when close is called', () => {
    component.navigateTo('credits');
    expect(component.overlayStack().length).toBe(1);

    component.close();
    expect(component.overlayStack().length).toBe(0);

    component.close();
    expect(dialogRefSpy.close).toHaveBeenCalledTimes(1);
  });

  describe('update settings row', () => {
    const row = (): HTMLElement | null =>
      (fixture.nativeElement as HTMLElement).querySelector('.item-label')?.closest('button') ??
      null;
    const subtitle = (): string[] =>
      Array.from(row()?.querySelectorAll('.item-subtitle span') ?? []).map(
        span => span.textContent?.trim() ?? ''
      );
    const skippedCount = (): string | undefined =>
      row()?.querySelector('.item-title .app-pill')?.textContent?.trim();

    beforeEach(() => {
      component.navigateTo('about-app');
      fixture.detectChanges();
    });

    it('summarises the channel and auto-check without showing the settings themselves', () => {
      expect(subtitle()).toEqual(['modals.about.channelStable', 'modals.about.autoCheck']);
      expect((fixture.nativeElement as HTMLElement).querySelector('.settings-card')).toBeNull();
    });

    it('leaves auto-check out of the summary while it is off', () => {
      autoCheckEnabled.set(false);
      fixture.detectChanges();
      expect(subtitle()).toEqual(['modals.about.channelStable']);
    });

    it('counts skipped versions only when there are some', () => {
      expect(skippedCount()).toBeUndefined();
      skippedVersions.set(['1.0.1', '1.0.2']);
      fixture.detectChanges();
      expect(skippedCount()).toBe('2');
    });

    it('opens the settings page with the toggle, the channel and the skipped versions', () => {
      skippedVersions.set(['1.0.1']);
      row()?.click();
      fixture.detectChanges();
      expect(component.currentView().id).toBe('app-update-settings');
      expect(component.pageTitles['app-update-settings']).toBe('modals.about.updateSettings');
      const page = fixture.nativeElement as HTMLElement;
      expect(page.querySelector('.settings-card mat-slide-toggle')).not.toBeNull();
      const channels = Array.from(page.querySelectorAll<HTMLElement>('[role="radio"]'));
      expect(channels.map(c => c.getAttribute('aria-checked'))).toEqual(['true', 'false']);
      channels[1].click();
      expect(setChannel).toHaveBeenCalledWith('beta');
      expect(page.querySelectorAll('.skipped-item')).toHaveLength(1);
    });
  });

  describe('release notes links', () => {
    const notes = [
      '[Dosya](/dosya/)',
      '[S3 Neon](/s3/#neon)',
      '[Resolve](#conflict-resolve)',
      '[Docs](https://rclone.org/docs/)',
      '[Mail](mailto:a@b.c)',
    ].join('\n\n');
    const hrefs = (target: 'app' | 'rclone'): (string | null)[] => {
      component.showReleaseNotes(
        { version: '1.0.0', currentVersion: '1.0.0', updateAvailable: false, releaseNotes: notes },
        target
      );
      fixture.detectChanges();
      return Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('.release-notes a')
      ).map(a => a.getAttribute('href'));
    };

    it("resolves rclone's site-relative links against rclone.org", () => {
      expect(hrefs('rclone')).toEqual([
        'https://rclone.org/dosya/',
        'https://rclone.org/s3/#neon',
        'https://rclone.org/changelog/#conflict-resolve',
        'https://rclone.org/docs/',
        'mailto:a@b.c',
      ]);
    });

    it('leaves the links of the app notes as they are', () => {
      expect(hrefs('app')).toEqual([
        '/dosya/',
        '/s3/#neon',
        '#conflict-resolve',
        'https://rclone.org/docs/',
        'mailto:a@b.c',
      ]);
    });
  });
});
