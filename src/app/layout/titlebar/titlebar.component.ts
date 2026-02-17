import { Component, OnInit, inject, ChangeDetectionStrategy, computed } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs/operators';

import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatBadgeModule } from '@angular/material/badge';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { AsyncPipe } from '@angular/common';
import { CdkMenuModule } from '@angular/cdk/menu';
import { TranslateService, TranslateModule } from '@ngx-translate/core';

// Services
import {
  BackupRestoreUiService,
  AppSettingsService,
  UiStateService,
  NautilusService,
  NotificationService,
  AppUpdaterService,
  RcloneUpdateService,
  RemoteManagementService,
  WindowService,
  ModalService,
  ConnectionService,
} from '@app/services';
import { Theme } from '@app/types';

@Component({
  selector: 'app-titlebar',
  standalone: true,
  imports: [
    AsyncPipe,
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
  dialog = inject(MatDialog);
  backupRestoreUiService = inject(BackupRestoreUiService);

  appSettingsService = inject(AppSettingsService);
  uiStateService = inject(UiStateService);
  nautilusService = inject(NautilusService);
  windowService = inject(WindowService);
  remoteManagementService = inject(RemoteManagementService);
  notificationService = inject(NotificationService);
  appUpdaterService = inject(AppUpdaterService);
  rcloneUpdateService = inject(RcloneUpdateService);
  private translateService = inject(TranslateService);

  readonly connectionService = inject(ConnectionService);

  windowButtons = true;

  // Signals for update states
  readonly updateAvailable = toSignal(this.appUpdaterService.updateAvailable$, {
    initialValue: null,
  });
  readonly rcloneUpdateAvailable = toSignal(
    this.rcloneUpdateService.updateStatus$.pipe(map(status => status.available)),
    { initialValue: false }
  );
  readonly restartRequired = toSignal(this.appUpdaterService.restartRequired$, {
    initialValue: false,
  });

  currentTheme$ = this.windowService.theme$;

  readonly updateTooltip = computed(() => {
    if (this.updateAvailable() && this.rcloneUpdateAvailable()) {
      return this.translateService.instant('titlebar.updates.all');
    } else if (this.updateAvailable()) {
      return this.translateService.instant('titlebar.updates.app');
    } else if (this.rcloneUpdateAvailable()) {
      return this.translateService.instant('titlebar.updates.rclone');
    } else if (this.restartRequired()) {
      return this.translateService.instant('titlebar.updates.restart');
    }
    return '';
  });

  readonly themes: { id: Theme; icon: string; label: string; class: string }[] = [
    { id: 'system', icon: 'circle-check', label: 'titlebar.menu.system', class: 'system' },
    { id: 'light', icon: 'circle-check', label: 'titlebar.menu.light', class: 'light' },
    { id: 'dark', icon: 'circle-check', label: 'titlebar.menu.dark', class: 'dark' },
  ];

  readonly isMaximized = toSignal(this.windowService.isMaximized$, { initialValue: false });

  readonly windowControls = computed(() => [
    {
      icon: 'remove',
      label: 'titlebar.minimize',
      action: (): Promise<void> => this.minimizeWindow(),
    },
    {
      icon: this.isMaximized() ? 'compress' : 'expand',
      label: 'titlebar.maximize',
      action: (): Promise<void> => this.maximizeWindow(),
    },
    {
      icon: 'close',
      label: 'titlebar.close',
      action: (): Promise<void> => this.closeWindow(),
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
    if (this.restartRequired()) return '!';
    if (this.updateAvailable() && this.rcloneUpdateAvailable()) {
      return '2';
    } else if (this.updateAvailable() || this.rcloneUpdateAvailable()) {
      return '!';
    }
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
    // Delegate all the complex logic to the service
    await this.windowService.setTheme(theme);
  }

  getInternetStatusTooltip(): string {
    return this.connectionService.getTooltip();
  }

  // Window Controls
  async minimizeWindow(): Promise<void> {
    await this.windowService.minimize();
  }

  async maximizeWindow(): Promise<void> {
    await this.windowService.maximize();
  }

  async closeWindow(): Promise<void> {
    await this.windowService.close();
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
