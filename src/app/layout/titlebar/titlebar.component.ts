import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { Subject } from 'rxjs';

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
})
export class TitlebarComponent implements OnInit, OnDestroy {
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
  updateAvailable = false;
  rcloneUpdateAvailable = false;
  restartRequired = false; // New property

  private destroy$ = new Subject<void>();
  currentTheme$ = this.windowService.theme$;

  constructor() {
    if (this.uiStateService.platform === 'macos' || this.uiStateService.platform === 'web') {
      this.windowButtons = false;
    }
  }

  async ngOnInit(): Promise<void> {
    try {
      await this.connectionService.runInternetCheck();
      await this.appUpdaterService.initialize();
      await this.rcloneUpdateService.initialize();

      this.appUpdaterService.updateAvailable$.subscribe(update => {
        this.updateAvailable = !!update;
      });

      this.rcloneUpdateService.updateStatus$.subscribe(status => {
        this.rcloneUpdateAvailable = status.available;
      });

      this.appUpdaterService.restartRequired$.subscribe(required => {
        this.restartRequired = required;
      });
    } catch (error) {
      console.error('Initialization error:', error);
    }
  }

  ngOnDestroy(): void {
    this.cleanup();
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

  getUpdateTooltip(): string {
    if (this.updateAvailable && this.rcloneUpdateAvailable) {
      return this.translateService.instant('titlebar.updates.all');
    } else if (this.updateAvailable) {
      return this.translateService.instant('titlebar.updates.app');
    } else if (this.rcloneUpdateAvailable) {
      return this.translateService.instant('titlebar.updates.rclone');
    } else if (this.restartRequired) {
      return this.translateService.instant('titlebar.updates.restart');
    }
    return '';
  }

  getAboutMenuTooltip(): string {
    return this.getUpdateTooltip();
  }

  getAboutMenuBadge(): string {
    if (this.restartRequired) return '!'; // Prioritize restart badge
    if (this.updateAvailable && this.rcloneUpdateAvailable) {
      return '2'; // Show number of available updates
    } else if (this.updateAvailable || this.rcloneUpdateAvailable) {
      return '!'; // Show single update indicator
    }
    return '';
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

  private cleanup(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}
