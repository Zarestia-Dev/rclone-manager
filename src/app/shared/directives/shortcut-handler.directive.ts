import { Directive, HostListener, inject } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { KeyboardShortcutsModalComponent } from '../../features/modals/settings/keyboard-shortcuts-modal/keyboard-shortcuts-modal.component';
import { QuickAddRemoteComponent } from '../../features/modals/remote-management/quick-add-remote/quick-add-remote.component';
import { RemoteConfigModalComponent } from '../../features/modals/remote-management/remote-config-modal/remote-config-modal.component';
import { ExportModalComponent } from '../../features/modals/settings/export-modal/export-modal.component';
import { PreferencesModalComponent } from '../../features/modals/settings/preferences-modal/preferences-modal.component';
import { RcloneConfigModalComponent } from '../../features/modals/settings/rclone-config-modal/rclone-config-modal.component';

// Services
import { WindowService } from '@app/services';
import { RemoteManagementService } from '@app/services';
import { NotificationService } from '../services/notification.service';
import { STANDARD_MODAL_SIZE } from '@app/types';

@Directive({
  selector: '[appShortcutHandler]',
  standalone: true,
})
export class ShortcutHandlerDirective {
  private dialog = inject(MatDialog);
  private notificationService = inject(NotificationService);
  private windowService = inject(WindowService);
  private remoteManagementService = inject(RemoteManagementService);

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    // Skip if typing in input fields (except for critical shortcuts)
    if (this.isInInputField(event) && !this.isCriticalShortcut(event)) {
      return;
    }

    // Handle shortcuts
    if (this.handleShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  private handleShortcut(event: KeyboardEvent): boolean {
    const { ctrlKey, shiftKey, altKey, key } = event;

    // Global shortcuts
    if (ctrlKey && !shiftKey && !altKey && key.toLowerCase() === 'q') {
      this.quitApplication();
      return true;
    }

    if (ctrlKey && shiftKey && !altKey && key.toLowerCase() === '?') {
      this.showKeyboardShortcuts();
      return true;
    }

    // Remote management shortcuts
    if (ctrlKey && shiftKey && !altKey && key.toLowerCase() === 'm') {
      this.forceRefreshMountedRemotes();
      return true;
    }

    if (ctrlKey && !shiftKey && !altKey && key.toLowerCase() === 'n') {
      this.createNewRemoteDetailed();
      return true;
    }

    if (ctrlKey && !shiftKey && !altKey && key.toLowerCase() === 'r') {
      this.createNewRemoteQuick();
      return true;
    }

    if (ctrlKey && !shiftKey && !altKey && key.toLowerCase() === 't') {
      this.createNewRemoteTerminal();
      return true;
    }

    if (ctrlKey && !shiftKey && !altKey && key.toLowerCase() === 'i') {
      this.loadConfiguration();
      return true;
    }

    if (ctrlKey && !shiftKey && !altKey && key.toLowerCase() === 'e') {
      this.exportConfiguration();
      return true;
    }

    // Navigation shortcuts
    if (!ctrlKey && !shiftKey && !altKey && key === 'Escape') {
      // Let individual components handle this
      return false;
    }

    // Settings shortcuts
    if (ctrlKey && !shiftKey && !altKey && key === ',') {
      this.openPreferences();
      return true;
    }

    if (ctrlKey && !shiftKey && !altKey && key === '.') {
      this.openRcloneConfig();
      return true;
    }

    return false;
  }

  private isInInputField(event: KeyboardEvent): boolean {
    const target = event.target as HTMLElement;
    return (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.contentEditable === 'true' ||
        target.isContentEditable)
    );
  }

  private isCriticalShortcut(event: KeyboardEvent): boolean {
    // Ctrl+Q should always work, even in input fields
    return event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'q';
  }

  private async quitApplication(): Promise<void> {
    try {
      await this.windowService.quitApplication();
    } catch (error) {
      this.notificationService.showError('Failed to quit application: ' + error);
    }
  }

  private async forceRefreshMountedRemotes(): Promise<void> {
    try {
      await this.remoteManagementService.forceRefreshMountedRemotes();
      this.notificationService.showSuccess('Mounted remotes refreshed successfully');
    } catch (error) {
      this.notificationService.showError('Failed to refresh mounted remotes: ' + error);
    }
  }

  private showKeyboardShortcuts(): void {
    this.dialog.open(KeyboardShortcutsModalComponent, STANDARD_MODAL_SIZE);
  }

  private createNewRemoteDetailed(): void {
    this.dialog.open(RemoteConfigModalComponent, STANDARD_MODAL_SIZE);
  }

  private createNewRemoteTerminal(): void {
    this.remoteManagementService.openRcloneConfigTerminal();
  }

  private createNewRemoteQuick(): void {
    this.dialog.open(QuickAddRemoteComponent, STANDARD_MODAL_SIZE);
  }

  private loadConfiguration(): void {
    console.log('Loading configuration');
    this.notificationService.showInfo('Configuration loading not yet implemented');
  }

  private exportConfiguration(): void {
    this.dialog.open(ExportModalComponent, STANDARD_MODAL_SIZE);
  }

  private openPreferences(): void {
    this.dialog.open(PreferencesModalComponent, STANDARD_MODAL_SIZE);
  }

  private openRcloneConfig(): void {
    this.dialog.open(RcloneConfigModalComponent, STANDARD_MODAL_SIZE);
  }
}
