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
  ],
  templateUrl: './app-menu.component.html',
  styleUrl: './app-menu.component.scss',
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

  readonly activeWorkspace = computed((): MainView => {
    if (this.nautilusService.isBrowserOverlayOpen()) return 'nautilus';
    if (this.flowOverlayService.isFlowOverlayOpen()) return 'flow';
    if (this.mainUiOverlayService.isMainUiOverlayOpen()) return 'main_menu';
    return this.uiStateService.selectedMainView();
  });

  goBackToBaseWorkspace(): void {
    this.nautilusService.closeBrowserOverlay();
    this.flowOverlayService.closeFlowOverlay();
    this.mainUiOverlayService.closeMainUiOverlay();
    this.uiStateService.setMainView(this.baseWorkspace());
  }

  openWorkspace(target: MainView): void {
    if (target === this.baseWorkspace()) {
      this.goBackToBaseWorkspace();
      return;
    }

    if (target === 'nautilus') {
      this.flowOverlayService.closeFlowOverlay();
      this.mainUiOverlayService.closeMainUiOverlay();
      if (this.baseWorkspace() === 'nautilus') {
        this.uiStateService.setMainView('nautilus');
      } else {
        void this.nautilusService.openBrowserOverlay(null, null);
      }
    } else if (target === 'flow') {
      this.nautilusService.closeBrowserOverlay();
      this.mainUiOverlayService.closeMainUiOverlay();
      if (this.baseWorkspace() === 'flow') {
        this.uiStateService.setMainView('flow');
      } else {
        void this.flowOverlayService.openFlowOverlay();
      }
    } else if (target === 'main_menu') {
      this.nautilusService.closeBrowserOverlay();
      this.flowOverlayService.closeFlowOverlay();
      if (this.baseWorkspace() === 'main_menu') {
        this.uiStateService.setMainView('main_menu');
      } else {
        void this.mainUiOverlayService.openMainUiOverlay();
      }
    }
  }

  openPreferencesModal(): void {
    this.modalService.openPreferences();
  }

  openRcloneFlagsModal(): void {
    this.modalService.openRcloneFlags();
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

  openAboutModal(): void {
    this.modalService.openAbout();
  }

  openAlertsModal(): void {
    this.modalService.openAlerts();
  }
}
