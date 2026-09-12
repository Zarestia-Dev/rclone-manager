import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { signal } from '@angular/core';
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

  beforeEach(async () => {
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
      readyToRestart: signal(false),
      downloadStatus: signal(null),
      isChecking: signal(false),
      buildType: signal('deb'),
      isUpdaterEnabled: signal(true),
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

  it('should initialize successfully', () => {
    expect(component).toBeTruthy();
    expect(component.rCloneManagerVersion).toBeDefined();
  });

  it('should have contributors list defined with expected entries', () => {
    expect(component.contributors).toBeDefined();
    expect(component.contributors.length).toBeGreaterThan(0);

    const draftingDreamer = component.contributors.find(c => c.github === 'DraftingDreamer');
    expect(draftingDreamer).toBeDefined();
    expect(draftingDreamer?.name).toBe('DraftingDreamer');

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
