import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { signal } from '@angular/core';

import { AppMenuComponent } from './app-menu.component';
import { ModalService } from 'src/app/services/ui/modal.service';
import { BackupRestoreUiService } from 'src/app/services/settings/backup-restore-ui.service';
import { AppNavigationService } from 'src/app/services/ui/app-navigation.service';
import { WindowService } from 'src/app/services/ui/window.service';
import { AppUpdaterService } from 'src/app/services/infrastructure/maintenance/app-updater.service';
import { RcloneUpdateService } from 'src/app/services/infrastructure/maintenance/rclone-update.service';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';
import { AlertService } from 'src/app/services/alerts/alert.service';
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
        { provide: AppNavigationService, useValue: { openWorkspace: vi.fn() } },
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
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AppMenuComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create the component', () => {
    expect(component).toBeTruthy();
  });

  it('exposes the theme choice as a radio group and names items by their text', () => {
    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('.menu-button')
      ?.click();
    fixture.detectChanges();
    const menu = document.querySelector('[role="menu"]');
    if (!menu) throw new Error('menu did not open');
    expect(menu.querySelector('.theme-selector')?.getAttribute('role')).toBe('group');
    const themes = Array.from(menu.querySelectorAll('.theme-button'));
    expect(themes.length).toBeGreaterThan(1);
    expect(themes.every(button => button.getAttribute('role') === 'menuitemradio')).toBe(true);
    expect(themes.filter(button => button.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    // A label that differs from the visible text hides that text from speech input users.
    expect(menu.querySelectorAll('.menu-item[aria-label]')).toHaveLength(0);
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

  it('opens a workspace through the shared navigation', async () => {
    const navigation = TestBed.inject(AppNavigationService);
    const open = vi.spyOn(navigation, 'openWorkspace').mockResolvedValue();
    await component.openWorkspace('flow');
    expect(open).toHaveBeenCalledExactlyOnceWith('flow');
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
