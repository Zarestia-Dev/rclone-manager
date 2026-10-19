import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { signal, WritableSignal } from '@angular/core';
import { AboutModalComponent } from './about-modal.component';
import { SystemInfoService } from 'src/app/services/infrastructure/system/system-info.service';
import { AppUpdaterService } from 'src/app/services/infrastructure/maintenance/app-updater.service';
import { RcloneUpdateService } from 'src/app/services/infrastructure/maintenance/rclone-update.service';
import { DebugService } from 'src/app/services/infrastructure/system/debug.service';
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
  const cancelUpdate = vi.fn();

  beforeEach(async () => {
    buildType = signal<string | null>(null);
    canAutoInstall = signal(true);
    readyToRestart = signal(false);
    installationFailure = signal('');
    cancelUpdate.mockReset().mockResolvedValue(undefined);
    dialogRefSpy = { close: vi.fn() };

    const mockSystemInfoService = {
      isLibrclone: vi.fn().mockResolvedValue(false),
    };

    const mockAppUpdaterService = {
      autoCheckEnabled: signal(true),
      updateAvailable: signal(null),
      updateInProgress: signal(false),
      updateChannel: signal('stable'),
      skippedVersions: signal([]),
      readyToRestart,
      isCancelling: signal(false),
      cancelUpdate,
      downloadStatus: signal(null),
      isChecking: signal(false),
      buildType,
      canAutoInstall,
      installationReason: signal(''),
      installationFailure,
    };

    const mockRcloneUpdateService = {
      updateAvailable: signal(null),
      hasUpdates: signal(false),
      downloading: signal(false),
      isChecking: signal(false),
      readyToRestart: signal(false),
      updateChannel: signal('stable'),
      skippedVersions: signal([]),
      autoCheckEnabled: signal(true),
      isUpdaterEnabled: signal(true),
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

  it.each(['flatpak', 'portable', 'container', null])(
    'uses the installation capability rather than the %s label for automatic updates',
    type => {
      buildType.set(type);
      canAutoInstall.set(true);
      expect(component.updateInstructions()).toBeNull();
    }
  );

  it.each([
    ['flatpak', 'flatpak update io.github.zarestia_dev.rclone-manager'],
    ['container', 'docker pull ghcr.io/zarestia-dev/rclone-manager:latest'],
  ])('provides installation-specific manual instructions for %s', (type, command) => {
    buildType.set(type);
    canAutoInstall.set(false);
    expect(component.updateInstructions()?.command).toBe(command);
  });

  it('directs AUR installations to the package source', () => {
    buildType.set('pacman');
    canAutoInstall.set(false);
    expect(component.updateInstructions()?.links[0].url).toBe(
      'https://aur.archlinux.org/packages?K=rclone-manager'
    );
    expect(component.updateInstructions()?.command).toBeUndefined();
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
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.platform-badge')?.textContent
    ).toContain('Docker');
    buildType.set(null);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.platform-badge')).toBeNull();
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
        '.restart-required button'
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
});
