import { Component, ChangeDetectionStrategy, inject, computed } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatBadgeModule } from '@angular/material/badge';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { CdkMenuModule } from '@angular/cdk/menu';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';

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
import { LongPressDirective } from 'src/app/shared/directives/long-press.directive';
import { SlideMenuController } from 'src/app/shared/utils';
import { Theme, MainView } from '@app/types';

@Component({
  selector: 'app-menu',
  standalone: true,
  imports: [
    CdkMenuModule,
    MatDividerModule,
    MatIconModule,
    MatButtonModule,
    MatBadgeModule,
    TranslatePipe,
    LongPressDirective,
  ],
  templateUrl: './app-menu.component.html',
  styleUrls: ['./app-menu.component.scss', '../../../styles/_slide-menu.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppMenuComponent {
  private readonly modalService = inject(ModalService);
  private readonly backupRestoreUiService = inject(BackupRestoreUiService);
  private readonly nautilusService = inject(NautilusService);
  private readonly windowService = inject(WindowService);
  private readonly appUpdaterService = inject(AppUpdaterService);
  private readonly rcloneUpdateService = inject(RcloneUpdateService);
  private readonly translateService = inject(TranslateService);
  private readonly flowOverlayService = inject(FlowOverlayService);
  private readonly mainUiOverlayService = inject(MainUiOverlayService);

  readonly uiStateService = inject(UiStateService);
  readonly alertService = inject(AlertService);

  readonly menuCtrl = new SlideMenuController<'main' | 'submenu'>('.app-sliding-container');

  // Signals for update states
  readonly hasUpdates = this.appUpdaterService.hasUpdates;
  readonly rcloneUpdateAvailable = this.rcloneUpdateService.hasUpdates;
  readonly rcloneRestartRequired = this.rcloneUpdateService.readyToRestart;
  readonly readyToRestart = this.appUpdaterService.readyToRestart;

  readonly currentTheme = this.windowService.theme;

  readonly updateTooltip = computed(() => {
    const appRestart = this.readyToRestart();
    const rcloneRestart = this.rcloneRestartRequired();
    const appUpdate = this.hasUpdates();
    const rcloneUpdate = this.rcloneUpdateAvailable();

    if (appRestart || rcloneRestart) {
      return this.translateService.instant('titlebar.updates.restart');
    } else if (appUpdate && rcloneUpdate) {
      return this.translateService.instant('titlebar.updates.all');
    } else if (appUpdate) {
      return this.translateService.instant('titlebar.updates.app');
    } else if (rcloneUpdate) {
      return this.translateService.instant('titlebar.updates.rclone');
    }
    return '';
  });

  readonly themes: { id: Theme; label: string; class: string }[] = [
    { id: 'system', label: 'titlebar.menu.system', class: 'system' },
    { id: 'light', label: 'titlebar.menu.light', class: 'light' },
    { id: 'dark', label: 'titlebar.menu.dark', class: 'dark' },
  ];

  readonly aboutMenuBadge = computed(() => {
    const appRestart = this.readyToRestart();
    const rcloneRestart = this.rcloneRestartRequired();
    const appUpdate = this.hasUpdates();
    const rcloneUpdate = this.rcloneUpdateAvailable();

    if (appRestart || rcloneRestart) return '!';
    if (appUpdate && rcloneUpdate) return '2';
    if (appUpdate || rcloneUpdate) return '!';
    return '';
  });

  async setTheme(theme: Theme, event?: MouseEvent): Promise<void> {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    await this.windowService.setTheme(theme);
  }

  readonly baseWorkspace = this.uiStateService.defaultView;

  readonly activeWorkspace = this.uiStateService.activeWorkspace;

  goBackToBaseWorkspace(): void {
    this.nautilusService.closeBrowserOverlay();
    this.flowOverlayService.closeFlowOverlay();
    this.mainUiOverlayService.closeMainUiOverlay();
    this.uiStateService.setMainView(this.baseWorkspace());
  }

  async openWorkspace(target: MainView): Promise<void> {
    if (target === this.baseWorkspace()) {
      this.goBackToBaseWorkspace();
      return;
    }

    // Keep the current workspace visible until the target has finished loading.
    if (target === 'nautilus') await this.nautilusService.openBrowserOverlay(null, null);
    else if (target === 'flow') await this.flowOverlayService.openFlowOverlay();
    else await this.mainUiOverlayService.openMainUiOverlay();

    if (target !== 'nautilus') this.nautilusService.closeBrowserOverlay();
    if (target !== 'flow') this.flowOverlayService.closeFlowOverlay();
    if (target !== 'main_menu') this.mainUiOverlayService.closeMainUiOverlay();
  }

  openPreferencesModal(): void {
    this.modalService.openPreferences();
  }

  openRcloneFlagsModal(): void {
    this.modalService.openRcloneFlags();
  }

  openVaultModal(): void {
    this.modalService.openVault();
  }

  onAdvancedKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      this.menuCtrl.openSubmenu('submenu');
      setTimeout(() => {
        const backBtn = document.querySelector<HTMLButtonElement>(
          '.app-sliding-container .menu-header button'
        );
        backBtn?.focus();
      }, 50);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      const current = event.currentTarget as HTMLElement | null;
      let next = current?.nextElementSibling as HTMLElement | null;
      while (next && next.tagName !== 'BUTTON') {
        next = next.nextElementSibling as HTMLElement | null;
      }
      next?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const current = event.currentTarget as HTMLElement | null;
      let prev = current?.previousElementSibling as HTMLElement | null;
      while (prev && prev.tagName !== 'BUTTON') {
        prev = prev.previousElementSibling as HTMLElement | null;
      }
      prev?.focus();
    }
  }

  onBackKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      this.menuCtrl.goBack();
      setTimeout(() => {
        const advBtn = document.querySelector<HTMLButtonElement>(
          '.app-sliding-container .advanced-menu-trigger'
        );
        advBtn?.focus();
      }, 50);
    }
  }

  openKeyboardShortcutsModal(): void {
    this.modalService.openKeyboardShortcuts();
  }

  openExportModal(): void {
    this.modalService.openExport();
  }

  restoreSettings(): void {
    this.backupRestoreUiService.launchRestoreFlow();
  }

  private longPressTriggered = false;

  onAboutLongPress(): void {
    this.longPressTriggered = true;
    this.openPowerMenuModal();
    setTimeout(() => {
      this.longPressTriggered = false;
    }, 400);
  }

  onAboutClicked(): void {
    if (this.longPressTriggered) {
      return;
    }
    this.openAboutModal();
  }

  openAboutModal(): void {
    this.modalService.openAbout();
  }

  openPowerMenuModal(): void {
    this.modalService.openPowerMenu();
  }

  openAlertsModal(): void {
    this.modalService.openAlerts();
  }
}
