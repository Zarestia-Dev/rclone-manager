import { Directive, HostListener, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { MatDialog } from '@angular/material/dialog';

// Services
import {
  MountManagementService,
  NautilusService,
  WindowService,
  BackupRestoreUiService,
  OnboardingStateService,
  NotificationService,
  ModalService,
} from '@app/services';

@Directive({
  selector: '[appShortcutHandler]',
  standalone: true,
})
export class ShortcutHandlerDirective {
  private readonly translate = inject(TranslateService);
  private readonly dialog = inject(MatDialog);
  private readonly modalService = inject(ModalService);
  private readonly notificationService = inject(NotificationService);
  private readonly windowService = inject(WindowService);
  private readonly onboardingStateService = inject(OnboardingStateService);
  private readonly mountManagementService = inject(MountManagementService);
  private readonly nautilusService = inject(NautilusService);
  private readonly backupRestoreUiService = inject(BackupRestoreUiService);

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    // Skip if typing in input fields (except for critical shortcuts)
    if (this.isInInputField(event) && !this.isCriticalShortcut(event)) {
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
    const { ctrlKey, shiftKey, altKey, key } = event;

    // Global shortcuts
    if (ctrlKey && !shiftKey && !altKey && key.toLowerCase() === 'q') {
      this.quitApplication();
      return true;
    }

    if (ctrlKey && !shiftKey && !altKey && key.toLowerCase() === 'b') {
      this.openFileBrowser();
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

  /**
   * Check if shortcuts should be blocked
   * Returns true if any modal is open or onboarding is active
   * Critical shortcuts (like Ctrl+Q) bypass this check
   */
  private shouldBlockShortcuts(event: KeyboardEvent): boolean {
    // Always allow critical shortcuts
    if (this.isCriticalShortcut(event)) {
      return false;
    }

    // Block if any modal is open
    if (this.dialog.openDialogs.length > 0) {
      console.debug('Shortcuts blocked: Modal is open');
      return true;
    }

    // Block if onboarding is active
    if (this.isOnboardingActive()) {
      console.debug('Shortcuts blocked: Onboarding is active');
      return true;
    }

    return false;
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

  private openFileBrowser(): void {
    this.nautilusService.toggleNautilusOverlay();
  }

  private async forceRefreshMountedRemotes(): Promise<void> {
    try {
      await this.mountManagementService.forceCheckMountedRemotes();
      this.notificationService.showSuccess(this.translate.instant('shortcuts.refreshSuccess'));
    } catch (error) {
      this.notificationService.showError(
        this.translate.instant('shortcuts.refreshError', { error })
      );
    }
  }

  private showKeyboardShortcuts(): void {
    this.modalService.openKeyboardShortcuts();
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

  private openRcloneConfig(): void {
    this.modalService.openRcloneConfig();
  }
}
