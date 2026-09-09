import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { signal } from '@angular/core';

import { AppMenuComponent } from './app-menu.component';
import { ModalService } from 'src/app/services/ui/modal.service';
import { BackupRestoreUiService } from 'src/app/services/settings/backup-restore-ui.service';
import { NautilusService } from 'src/app/services/ui/nautilus.service';
import { WindowService } from 'src/app/services/ui/window.service';
import { AppUpdaterService } from 'src/app/services/infrastructure/maintenance/app-updater.service';
import { RcloneUpdateService } from 'src/app/services/infrastructure/maintenance/rclone-update.service';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';
import { AlertService } from 'src/app/services/alerts/alert.service';
import { FlowOverlayService } from 'src/app/services/ui/flow-overlay.service';
import { MainUiOverlayService } from 'src/app/services/ui/main-ui-overlay.service';
import { Theme } from '@app/types';

describe('AppMenuComponent', () => {
  let fixture: ComponentFixture<AppMenuComponent>;
  let component: AppMenuComponent;
  let modalServiceSpy: {
    openAbout: ReturnType<typeof vi.fn>;
    openPowerMenu: ReturnType<typeof vi.fn>;
    openPreferences: ReturnType<typeof vi.fn>;
    openRcloneFlags: ReturnType<typeof vi.fn>;
    openKeyboardShortcuts: ReturnType<typeof vi.fn>;
    openExport: ReturnType<typeof vi.fn>;
    openAlerts: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    modalServiceSpy = {
      openAbout: vi.fn(),
      openPowerMenu: vi.fn(),
      openPreferences: vi.fn(),
      openRcloneFlags: vi.fn(),
      openKeyboardShortcuts: vi.fn(),
      openExport: vi.fn(),
      openAlerts: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [AppMenuComponent],
      providers: [
        provideTranslateService(),
        { provide: ModalService, useValue: modalServiceSpy },
        { provide: BackupRestoreUiService, useValue: { launchRestoreFlow: vi.fn() } },
        {
          provide: NautilusService,
          useValue: { isStandaloneWindow: vi.fn().mockReturnValue(false) },
        },
        {
          provide: WindowService,
          useValue: {
            theme: signal<Theme>('system'),
            setTheme: vi.fn(),
          },
        },
        {
          provide: AppUpdaterService,
          useValue: {
            hasUpdates: signal(false),
            readyToRestart: signal(false),
          },
        },
        {
          provide: RcloneUpdateService,
          useValue: {
            hasUpdates: signal(false),
            readyToRestart: signal(false),
          },
        },
        {
          provide: UiStateService,
          useValue: {
            activeWorkspace: signal('main_menu'),
            baseWorkspace: signal('main_menu'),
          },
        },
        {
          provide: AlertService,
          useValue: {
            unacknowledged: signal(0),
          },
        },
        {
          provide: FlowOverlayService,
          useValue: { isFlowOverlayOpen: vi.fn().mockReturnValue(false) },
        },
        {
          provide: MainUiOverlayService,
          useValue: { isMainUiOverlayOpen: vi.fn().mockReturnValue(false) },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AppMenuComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create the component', () => {
    expect(component).toBeTruthy();
  });

  it('should open power menu modal directly', () => {
    component.openPowerMenuModal();
    expect(modalServiceSpy.openPowerMenu).toHaveBeenCalled();
  });

  it('should open about modal on normal click', () => {
    component.onAboutClicked();
    expect(modalServiceSpy.openAbout).toHaveBeenCalled();
  });

  it('should open power menu on long press and suppress subsequent click', () => {
    component.onAboutLongPress();
    expect(modalServiceSpy.openPowerMenu).toHaveBeenCalled();

    component.onAboutClicked();
    expect(modalServiceSpy.openAbout).not.toHaveBeenCalled();
  });
});
