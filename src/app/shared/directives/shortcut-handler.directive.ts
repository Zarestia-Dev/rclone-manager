import { Directive, HostListener, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { MatDialog } from '@angular/material/dialog';

// Services
import { MountManagementService } from 'src/app/services/operations/mount-management.service';
import { ServeManagementService } from 'src/app/services/operations/serve-management.service';
import { NautilusService } from 'src/app/services/ui/nautilus.service';
import { WindowService } from 'src/app/services/ui/window.service';
import { BackupRestoreUiService } from 'src/app/services/settings/backup-restore-ui.service';
import { OnboardingStateService } from 'src/app/services/ui/state/onboarding-state.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { ModalService } from 'src/app/services/ui/modal.service';
import { FlowOverlayService } from 'src/app/services/ui/flow-overlay.service';
import { isInputFocused, matchesShortcut } from '../utils/keyboard-utils';
import { MAIN_SHORTCUTS } from '../models/shortcut-definitions';

@Directive({
  selector: '[appShortcutHandler]',
})
export class ShortcutHandlerDirective {
  private readonly translate = inject(TranslateService);
  private readonly dialog = inject(MatDialog);
  private readonly modalService = inject(ModalService);
  private readonly notificationService = inject(NotificationService);
  private readonly windowService = inject(WindowService);
  private readonly onboardingStateService = inject(OnboardingStateService);
  private readonly mountManagementService = inject(MountManagementService);
  private readonly serveManagementService = inject(ServeManagementService);
  private readonly nautilusService = inject(NautilusService);
  private readonly backupRestoreUiService = inject(BackupRestoreUiService);
  private readonly flowOverlayService = inject(FlowOverlayService);

  private readonly actionMap: Record<string, () => void | Promise<void>> = {
    'app.quit': () => this.quitApplication(),
    'app.toggleFileBrowser': () => this.toggleFileBrowser(),
    'app.showShortcuts': () => this.showKeyboardShortcuts(),
    'app.forceRefreshMountedRemotes': () => this.forceRefreshMountedRemotes(),
    'app.forceRefreshServes': () => this.forceRefreshServes(),
    'app.createNewRemoteDetailed': () => this.createNewRemoteDetailed(),
    'app.createNewRemoteQuick': () => this.createNewRemoteQuick(),
    'app.loadConfiguration': () => this.loadConfiguration(),
    'app.exportConfiguration': () => this.exportConfiguration(),
    'app.openPreferences': () => this.openPreferences(),
    'app.openFlags': () => this.openRcloneFlags(),
    'app.openAlerts': () => this.openAlerts(),
    'app.toggleFlowOverlay': () => this.toggleFlowOverlay(),
  };

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    // Skip if typing in input fields (except for critical shortcuts)
    if (isInputFocused(event) && !this.isCriticalShortcut(event)) {
      return;
    }

    // Block shortcuts if any modal is open or onboarding is active
    if (this.shouldBlockShortcuts(event)) {
      return;
    }

    // Handle shortcuts
    if (this.handleShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  private handleShortcut(event: KeyboardEvent): boolean {
    const matched = MAIN_SHORTCUTS.find(s => matchesShortcut(s.keys, event));
    if (matched && this.actionMap[matched.actionId]) {
      void this.actionMap[matched.actionId]();
      return true;
    }
    return false;
  }

  private isCriticalShortcut(event: KeyboardEvent): boolean {
    return matchesShortcut('Ctrl + Q', event);
  }

  /**
   * Check if shortcuts should be blocked
   * Returns true if any modal is open, file viewer is open, or onboarding is active
   * Critical shortcuts (like Ctrl+Q) bypass this check
   */
  private shouldBlockShortcuts(event: KeyboardEvent): boolean {
    // Block all shortcuts when keyboard shortcuts modal is open (so user can test them safely)
    if (this.isShortcutsModalOpen()) {
      return true;
    }

    // Always allow critical shortcuts
    if (this.isCriticalShortcut(event)) {
      return false;
    }

    return (
      this.isFileViewerOpen() || this.dialog.openDialogs.length > 0 || this.isOnboardingActive()
    );
  }

  /**
   * Check if keyboard shortcuts cheat sheet modal is open
   */
  private isShortcutsModalOpen(): boolean {
    return document.querySelector('app-keyboard-shortcuts-modal') !== null;
  }

  /**
   * Check if file viewer modal is open
   */
  private isFileViewerOpen(): boolean {
    return document.querySelector('app-file-viewer-modal') !== null;
  }

  /**
   * Check if onboarding is currently active using centralized service
   */
  private isOnboardingActive(): boolean {
    return this.onboardingStateService.isOnboardingActive();
  }

  private async quitApplication(): Promise<void> {
    try {
      await this.windowService.quitApplication();
    } catch (error) {
      this.notificationService.showError(this.translate.instant('shortcuts.quitError', { error }));
    }
  }

  private toggleFileBrowser(): void {
    this.nautilusService.toggleNautilusOverlay();
  }

  private async forceRefreshMountedRemotes(): Promise<void> {
    try {
      await this.mountManagementService.forceCheckMountedRemotes();
      this.notificationService.showSuccess(
        this.translate.instant('shortcuts.mountsRefreshSuccess')
      );
    } catch (error) {
      this.notificationService.showError(
        this.translate.instant('shortcuts.mountsRefreshError', { error })
      );
    }
  }

  private async forceRefreshServes(): Promise<void> {
    try {
      await this.serveManagementService.forceCheckServes();
      this.notificationService.showSuccess(
        this.translate.instant('shortcuts.servesRefreshSuccess')
      );
    } catch (error) {
      this.notificationService.showError(
        this.translate.instant('shortcuts.servesRefreshError', { error })
      );
    }
  }

  private showKeyboardShortcuts(): void {
    if (this.flowOverlayService.isFlowOverlayOpen()) {
      this.modalService.openKeyboardShortcuts({ context: 'flow' });
    } else if (this.nautilusService.isBrowserOverlayOpen()) {
      this.modalService.openKeyboardShortcuts({ context: 'nautilus' });
    } else {
      this.modalService.openKeyboardShortcuts({ context: 'main' });
    }
  }

  private createNewRemoteDetailed(): void {
    this.modalService.openRemoteConfig();
  }

  private createNewRemoteQuick(): void {
    this.modalService.openQuickAddRemote();
  }

  private loadConfiguration(): void {
    this.backupRestoreUiService.launchRestoreFlow();
  }

  private exportConfiguration(): void {
    this.modalService.openExport();
  }

  private openPreferences(): void {
    this.modalService.openPreferences();
  }

  private openRcloneFlags(): void {
    this.modalService.openRcloneFlags();
  }

  private openAlerts(): void {
    this.modalService.openAlerts();
  }

  private toggleFlowOverlay(): void {
    this.flowOverlayService.toggleFlowOverlay();
  }
}
