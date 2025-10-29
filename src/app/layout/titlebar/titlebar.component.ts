import { Component, OnInit, OnDestroy, inject, Type } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { Subject, Subscription } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { InputModalComponent } from '../../shared/modals/input-modal/input-modal.component';

import { MatMenuModule } from '@angular/material/menu';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatBadgeModule } from '@angular/material/badge';
import { ExportModalComponent } from '../../features/modals/settings/export-modal/export-modal.component';
import { PreferencesModalComponent } from '../../features/modals/settings/preferences-modal/preferences-modal.component';
import { RcloneConfigModalComponent } from '../../features/modals/settings/rclone-config-modal/rclone-config-modal.component';
import { KeyboardShortcutsModalComponent } from '../../features/modals/settings/keyboard-shortcuts-modal/keyboard-shortcuts-modal.component';
import { AboutModalComponent } from '../../features/modals/settings/about-modal/about-modal.component';
import { QuickAddRemoteComponent } from '../../features/modals/remote-management/quick-add-remote/quick-add-remote.component';
import { RemoteConfigModalComponent } from '../../features/modals/remote-management/remote-config-modal/remote-config-modal.component';

// Services
import { RemoteManagementService, WindowService } from '@app/services';
import { BackupRestoreService } from '@app/services';
import { FileSystemService } from '@app/services';
import { AppSettingsService } from '@app/services';
import { UiStateService } from '@app/services';
import { NotificationService } from 'src/app/shared/services/notification.service';
import { AppUpdaterService, RcloneUpdateService } from '@app/services';
import { CheckResult, ConnectionStatus, ModalSize, STANDARD_MODAL_SIZE, Theme } from '@app/types';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { AsyncPipe } from '@angular/common';

@Component({
  selector: 'app-titlebar',
  standalone: true,
  imports: [
    AsyncPipe,
    MatMenuModule,
    MatDividerModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    MatBadgeModule,
  ],
  templateUrl: './titlebar.component.html',
  styleUrls: ['./titlebar.component.scss'],
})
export class TitlebarComponent implements OnInit, OnDestroy {
  dialog = inject(MatDialog);
  backupRestoreService = inject(BackupRestoreService);
  fileSystemService = inject(FileSystemService);
  appSettingsService = inject(AppSettingsService);
  uiStateService = inject(UiStateService);
  windowService = inject(WindowService);
  remoteManagementService = inject(RemoteManagementService);
  notificationService = inject(NotificationService);
  appUpdaterService = inject(AppUpdaterService);
  rcloneUpdateService = inject(RcloneUpdateService);

  isMacOS = false;
  connectionStatus: ConnectionStatus = 'online';
  connectionHistory: { timestamp: Date; result: CheckResult }[] = [];
  result?: CheckResult;
  updateAvailable = false;
  rcloneUpdateAvailable = false;

  private destroy$ = new Subject<void>();
  private internetCheckSub?: Subscription;
  currentTheme$ = this.windowService.theme$;

  constructor() {
    if (this.uiStateService.platform === 'macos') {
      this.isMacOS = true;
    }
  }

  async ngOnInit(): Promise<void> {
    try {
      await this.runInternetCheck();
      await this.appUpdaterService.initialize();
      await this.rcloneUpdateService.initialize();

      this.appUpdaterService.updateAvailable$.subscribe(update => {
        this.updateAvailable = !!update;
      });

      this.rcloneUpdateService.updateStatus$.subscribe(status => {
        this.rcloneUpdateAvailable = status.available;
      });

      this.checkAutoUpdate();
      this.checkRcloneAutoUpdate();
    } catch (error) {
      console.error('Initialization error:', error);
    }
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  // --- Theme Method (Simplified) ---
  async setTheme(theme: Theme, event?: MouseEvent): Promise<void> {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    // Delegate all the complex logic to the service
    await this.windowService.setTheme(theme);
  }

  private async checkAutoUpdate(): Promise<void> {
    try {
      const autoCheckEnabled = await this.appUpdaterService.getAutoCheckEnabled();
      if (autoCheckEnabled && !this.appUpdaterService.areUpdatesDisabled()) {
        // Check for updates on app start
        await this.appUpdaterService.checkForUpdates();
      }
    } catch (error) {
      console.error('Failed to check for auto-updates:', error);
    }
  }

  private async checkRcloneAutoUpdate(): Promise<void> {
    try {
      const autoCheckEnabled = await this.rcloneUpdateService.getAutoCheckEnabled();
      if (autoCheckEnabled) {
        // Check for rclone updates on app start
        console.log('🔍 Auto-checking for rclone updates on app launch...');
        await this.rcloneUpdateService.checkForUpdates();
      }
    } catch (error) {
      console.error('Failed to check for rclone auto-updates:', error);
    }
  }

  // Connection Checking
  async runInternetCheck(): Promise<void> {
    if (this.connectionStatus === 'checking') return;

    this.connectionStatus = 'checking';
    try {
      const links = await this.appSettingsService.loadSettingValue('core', 'connection_check_urls');

      console.log('Loaded connection check URLs:', links);

      if (this.internetCheckSub) {
        this.internetCheckSub.unsubscribe();
      }

      try {
        const result = await this.appSettingsService.checkInternetLinks(
          links,
          2, // retries
          3 // delay in seconds
        );
        console.log('Connection check result:', result);

        this.result = result;
        this.connectionHistory.unshift({
          timestamp: new Date(),
          result: result,
        });
        if (this.connectionHistory.length > 5) {
          this.connectionHistory.pop();
        }
        this.connectionStatus =
          Object.keys(this.result?.failed || {}).length > 0 ? 'offline' : 'online';
      } catch (err) {
        console.error('Connection check failed:', err);
        this.result = { successful: [], failed: {}, retries_used: {} };
        this.connectionStatus = 'offline';
        console.error('Connection check failed');
      }
    } catch (err) {
      console.error('Connection check error:', err);
      this.connectionStatus = 'offline';
      console.error('Failed to load connection check settings');
    }
  }

  getInternetStatusTooltip(): string {
    if (this.connectionStatus === 'checking') return 'Checking internet connection...';

    if (this.result && Object.keys(this.result.failed).length > 0) {
      const services = Object.keys(this.result.failed)
        .map(url => {
          if (url.includes('google')) return 'Google Drive';
          if (url.includes('dropbox')) return 'Dropbox';
          if (url.includes('onedrive')) return 'OneDrive';
          return new URL(url).hostname;
        })
        .join(', ');

      return `Cannot connect to: ${services}. Some features may not work as expected. Click to retry.`;
    }

    return 'Your internet connection is working properly.';
  }

  getUpdateTooltip(): string {
    if (this.updateAvailable && this.rcloneUpdateAvailable) {
      return 'Application and Rclone updates available';
    } else if (this.updateAvailable) {
      return 'Application update available';
    } else if (this.rcloneUpdateAvailable) {
      return 'Rclone update available';
    }
    return '';
  }

  getAboutMenuTooltip(): string {
    return this.getUpdateTooltip();
  }

  getAboutMenuBadge(): string {
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
    this.openModal(QuickAddRemoteComponent, STANDARD_MODAL_SIZE);
  }

  openRemoteConfigModal(): void {
    this.openModal(RemoteConfigModalComponent, STANDARD_MODAL_SIZE);
  }

  openPreferencesModal(): void {
    this.openModal(PreferencesModalComponent, STANDARD_MODAL_SIZE);
  }

  openRcloneConfigModal(): void {
    this.openModal(RcloneConfigModalComponent, STANDARD_MODAL_SIZE);
  }

  openKeyboardShortcutsModal(): void {
    this.openModal(KeyboardShortcutsModalComponent, STANDARD_MODAL_SIZE);
  }

  openExportModal(): void {
    this.openModal(ExportModalComponent, STANDARD_MODAL_SIZE);
  }

  openAboutModal(): void {
    this.openModal(AboutModalComponent, {
      width: '362px',
      maxWidth: '362px',
      minWidth: '360px',
      height: '80vh',
      maxHeight: '600px',
    });
  }

  private openModal(component: Type<unknown>, size: ModalSize): void {
    this.dialog.open(component, {
      ...size,
      disableClose: true,
    });
  }

  // Other Methods
  resetRemote(): void {
    this.uiStateService.resetSelectedRemote();
  }

  async openRemoteConfigTerminal(): Promise<void> {
    try {
      await this.remoteManagementService.openRcloneConfigTerminal();
    } catch (error) {
      console.error('Error opening Rclone config terminal:', error);
      this.notificationService.openSnackBar(
        `Failed to open Rclone config terminal: ${error}`,
        'OK'
      );
    }
  }

  async restoreSettings(): Promise<void> {
    const path = await this.fileSystemService.selectFile();
    if (!path) return;

    const result = await this.backupRestoreService.analyzeBackupFile(path);
    if (!result) return;

    if (result.isEncrypted) {
      this.handleEncryptedBackup(path);
    } else {
      await this.backupRestoreService.restoreSettings(path);
    }
  }

  private handleEncryptedBackup(path: string): void {
    const dialogRef = this.dialog.open(InputModalComponent, {
      width: '400px',
      disableClose: true,
      data: {
        title: 'Enter Password',
        description: 'Please enter the password to decrypt the backup file.',
        fields: [
          {
            name: 'password',
            label: 'Password',
            type: 'password',
            required: true,
          },
        ],
      },
    });

    dialogRef
      .afterClosed()
      .pipe(takeUntil(this.destroy$))
      .subscribe(async inputData => {
        if (inputData?.password) {
          await this.backupRestoreService.restoreEncryptedSettings(path, inputData.password);
        }
      });
  }

  private cleanup(): void {
    this.destroy$.next();
    this.destroy$.complete();
    if (this.internetCheckSub) {
      this.internetCheckSub.unsubscribe();
    }
  }
}
