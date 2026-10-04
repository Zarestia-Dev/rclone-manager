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
    openVault: ReturnType<typeof vi.fn>;
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
      openVault: vi.fn(),
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
          useValue: {
            isStandaloneWindow: vi.fn().mockReturnValue(false),
            openBrowserOverlay: vi.fn().mockResolvedValue(undefined),
            closeBrowserOverlay: vi.fn(),
          },
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
            defaultView: signal('main_menu'),
            setMainView: vi.fn(),
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
          useValue: {
            isFlowOverlayOpen: vi.fn().mockReturnValue(false),
            openFlowOverlay: vi.fn().mockResolvedValue(undefined),
            closeFlowOverlay: vi.fn(),
          },
        },
        {
          provide: MainUiOverlayService,
          useValue: {
            isMainUiOverlayOpen: vi.fn().mockReturnValue(false),
            openMainUiOverlay: vi.fn().mockResolvedValue(undefined),
            closeMainUiOverlay: vi.fn(),
          },
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

  it('should open vault modal when openVaultModal is called', () => {
    component.openVaultModal();
    expect(modalServiceSpy.openVault).toHaveBeenCalled();
  });

  it('should open power menu on long press and suppress subsequent click', () => {
    component.onAboutLongPress();
    expect(modalServiceSpy.openPowerMenu).toHaveBeenCalled();

    component.onAboutClicked();
    expect(modalServiceSpy.openAbout).not.toHaveBeenCalled();
  });
  it('should navigate between main and advanced views using menuCtrl', () => {
    expect(component.menuCtrl.currentMenuView()).toBe('main');

    component.menuCtrl.openSubmenu('submenu');
    expect(component.menuCtrl.currentMenuView()).toBe('submenu');

    component.menuCtrl.goBack();
    expect(component.menuCtrl.currentMenuView()).toBe('main');

    component.menuCtrl.openSubmenu('submenu');
    expect(component.menuCtrl.currentMenuView()).toBe('submenu');

    component.menuCtrl.reset();
    expect(component.menuCtrl.currentMenuView()).toBe('main');
  });

  it('should open preferences modal when openPreferencesModal is called', () => {
    component.openPreferencesModal();
    expect(modalServiceSpy.openPreferences).toHaveBeenCalled();
  });

  it('should open rclone flags modal when openRcloneFlagsModal is called', () => {
    component.openRcloneFlagsModal();
    expect(modalServiceSpy.openRcloneFlags).toHaveBeenCalled();
  });

  it('keeps the old workspace visible until the requested overlay finishes loading', async () => {
    let finish!: () => void;
    const loading = new Promise<void>(resolve => {
      finish = resolve;
    });
    const flow = TestBed.inject(FlowOverlayService);
    const nautilus = TestBed.inject(NautilusService);
    vi.spyOn(flow, 'openFlowOverlay').mockReturnValue(loading);
    const opening = component.openWorkspace('flow');
    expect(nautilus.closeBrowserOverlay).not.toHaveBeenCalled();
    finish();
    await opening;
    expect(nautilus.closeBrowserOverlay).toHaveBeenCalledOnce();
    expect(flow.closeFlowOverlay).not.toHaveBeenCalled();
  });

  it('handles keyboard navigation into and back from submenu', () => {
    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    vi.spyOn(enterEvent, 'preventDefault');
    component.onAdvancedKeydown(enterEvent);
    expect(enterEvent.preventDefault).toHaveBeenCalled();
    expect(component.menuCtrl.currentMenuView()).toBe('submenu');

    const backEvent = new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true });
    vi.spyOn(backEvent, 'preventDefault');
    component.onBackKeydown(backEvent);
    expect(backEvent.preventDefault).toHaveBeenCalled();
    expect(component.menuCtrl.currentMenuView()).toBe('main');
  });
});
