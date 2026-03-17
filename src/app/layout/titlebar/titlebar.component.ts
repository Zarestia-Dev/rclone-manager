import { Component, OnInit, inject, ChangeDetectionStrategy, computed } from '@angular/core';

import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatBadgeModule } from '@angular/material/badge';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { CdkMenuModule } from '@angular/cdk/menu';
import { TranslateService, TranslateModule } from '@ngx-translate/core';

// Services
import {
  BackupRestoreUiService,
  UiStateService,
  NautilusService,
  AppUpdaterService,
  RcloneUpdateService,
  WindowService,
  ModalService,
  ConnectionService,
} from '@app/services';
import { Theme } from '@app/types';

@Component({
  selector: 'app-titlebar',
  standalone: true,
  imports: [
    CdkMenuModule,
    MatDividerModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    MatBadgeModule,
    TranslateModule,
  ],
  templateUrl: './titlebar.component.html',
  styleUrls: ['./titlebar.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TitlebarComponent implements OnInit {
  private readonly modalService = inject(ModalService);
  private readonly backupRestoreUiService = inject(BackupRestoreUiService);
  private readonly nautilusService = inject(NautilusService);
  private readonly windowService = inject(WindowService);
  private readonly appUpdaterService = inject(AppUpdaterService);
  private readonly rcloneUpdateService = inject(RcloneUpdateService);
  private readonly translateService = inject(TranslateService);

  readonly uiStateService = inject(UiStateService);
  readonly connectionService = inject(ConnectionService);

  windowButtons = true;

  // Signals for update states
  readonly updateAvailable = this.appUpdaterService.updateAvailable;
  readonly rcloneUpdateAvailable = computed(
    () => this.rcloneUpdateService.updateStatus().available
  );
  readonly rcloneRestartRequired = computed(
    () => this.rcloneUpdateService.updateStatus().readyToRestart
  );
  readonly restartRequired = this.appUpdaterService.restartRequired;

  readonly currentTheme = this.windowService.theme;

  readonly updateTooltip = computed(() => {
    const appRestart = this.restartRequired();
    const rcloneRestart = this.rcloneRestartRequired();

    if (this.updateAvailable() && this.rcloneUpdateAvailable()) {
      return this.translateService.instant('titlebar.updates.all');
    } else if (this.updateAvailable()) {
      return this.translateService.instant('titlebar.updates.app');
    } else if (this.rcloneUpdateAvailable()) {
      return this.translateService.instant('titlebar.updates.rclone');
    } else if (appRestart || rcloneRestart) {
      return this.translateService.instant('titlebar.updates.restart');
    }
    return '';
  });

  readonly themes: { id: Theme; icon: string; label: string; class: string }[] = [
    { id: 'system', icon: 'circle-check', label: 'titlebar.menu.system', class: 'system' },
    { id: 'light', icon: 'circle-check', label: 'titlebar.menu.light', class: 'light' },
    { id: 'dark', icon: 'circle-check', label: 'titlebar.menu.dark', class: 'dark' },
  ];

  private readonly isMaximized = this.windowService.isMaximized;

  readonly windowControls = computed(() => [
    {
      icon: 'minimize',
      label: 'titlebar.minimize',
      action: (): Promise<void> => this.windowService.minimize(),
    },
    {
      icon: this.isMaximized() ? 'collapse' : 'expand',
      label: 'titlebar.maximize',
      action: (): Promise<void> => this.windowService.maximize(),
    },
    {
      icon: 'close',
      label: 'titlebar.close',
      action: (): Promise<void> => this.windowService.close(),
      class: 'close-button',
    },
  ]);

  readonly addRemoteMenuItems = [
    {
      label: 'titlebar.menu.quickRemote',
      shortcut: 'Ctrl + R',
      action: (): void => this.openQuickAddRemoteModal(),
    },
    {
      label: 'titlebar.menu.detailedRemote',
      shortcut: 'Ctrl + N',
      action: (): void => this.openRemoteConfigModal(),
    },
  ];

  readonly menuItems = [
    {
      label: 'titlebar.menu.import',
      shortcut: 'Ctrl + I',
      action: (): void => this.restoreSettings(),
      divider: true,
    },
    {
      label: 'titlebar.menu.export',
      shortcut: 'Ctrl + E',
      action: (): void => this.openExportModal(),
      dividerAfter: true,
    },
    {
      label: 'titlebar.menu.preferences',
      shortcut: 'Ctrl + ,',
      action: (): void => this.openPreferencesModal(),
    },
    {
      label: 'titlebar.menu.configuration',
      shortcut: 'Ctrl + .',
      action: (): void => this.openRcloneConfigModal(),
      dividerAfter: true,
    },
    {
      label: 'titlebar.menu.fileBrowser',
      shortcut: 'Ctrl + B',
      action: (): void => this.onBrowseClick(),
      dividerAfter: true,
    },
    {
      label: 'titlebar.menu.shortcuts',
      shortcut: 'Ctrl + ?',
      action: (): void => this.openKeyboardShortcutsModal(),
      dividerAfter: true,
    },
  ];

  readonly aboutMenuBadge = computed(() => {
    if (this.restartRequired() || this.rcloneRestartRequired()) return '!';
    if (this.updateAvailable() && this.rcloneUpdateAvailable()) return '2';
    if (this.updateAvailable() || this.rcloneUpdateAvailable()) return '!';
    return '';
  });

  constructor() {
    if (this.uiStateService.platform === 'macos' || this.uiStateService.platform === 'web') {
      this.windowButtons = false;
    }
  }

  async ngOnInit(): Promise<void> {
    try {
      await this.connectionService.runInternetCheck();
    } catch (error) {
      console.error('Initialization error:', error);
    }
  }

  async setTheme(theme: Theme, event?: MouseEvent): Promise<void> {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    await this.windowService.setTheme(theme);
  }

  // Modal Methods
  openQuickAddRemoteModal(): void {
    this.modalService.openQuickAddRemote();
  }

  openRemoteConfigModal(): void {
    this.modalService.openRemoteConfig();
  }

  openPreferencesModal(): void {
    this.modalService.openPreferences();
  }

  openRcloneConfigModal(): void {
    this.modalService.openRcloneConfig();
  }

  openKeyboardShortcutsModal(): void {
    this.modalService.openKeyboardShortcuts();
  }

  openExportModal(): void {
    this.modalService.openExport();
  }

  openAboutModal(): void {
    this.modalService.openAbout();
  }

  // Other Methods
  resetRemote(): void {
    this.uiStateService.resetSelectedRemote();
  }

  restoreSettings(): void {
    this.backupRestoreUiService.launchRestoreFlow();
  }

  onBrowseClick(): void {
    this.nautilusService.toggleNautilusOverlay();
  }
}
