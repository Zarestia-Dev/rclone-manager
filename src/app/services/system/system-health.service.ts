import { Injectable, signal, computed, inject } from '@angular/core';
import { MatBottomSheet, MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { firstValueFrom } from 'rxjs';
import { RepairSheetComponent } from '../../features/components/repair-sheet/repair-sheet.component';
import { RepairData, RepairSheetType, PasswordPromptResult } from '@app/types';
import { SystemInfoService } from './system-info.service';
import { InstallationService } from '../settings/installation.service';
import { RclonePasswordService } from '../security/rclone-password.service';
import { EventListenersService } from './event-listeners.service';

/** Types of system problems that can be detected */
export type SystemProblem = 'rclone-missing' | 'mount-plugin-missing' | 'password-required';

/**
 * Centralized service to track system health and problems.
 * Provides reactive signals that components can subscribe to.
 */
@Injectable({
  providedIn: 'root',
})
export class SystemHealthService {
  private readonly systemInfoService = inject(SystemInfoService);
  private readonly installationService = inject(InstallationService);
  private readonly rclonePasswordService = inject(RclonePasswordService);
  private readonly eventListenersService = inject(EventListenersService);
  private readonly bottomSheet = inject(MatBottomSheet);

  private readonly activeSheets = new Set<MatBottomSheetRef<RepairSheetComponent>>();

  // ─── Core State Signals ─────────────────────────────────────────────────────
  // null = not checked yet, true/false = checked

  /** Whether rclone binary is installed and accessible */
  readonly rcloneInstalled = signal<boolean | null>(null);

  /** Whether the mount plugin (FUSE) is installed */
  readonly mountPluginInstalled = signal<boolean | null>(null);

  /** Whether the rclone config file is encrypted */
  readonly configEncrypted = signal<boolean | null>(null);

  /** Whether the password has been successfully entered for this session */
  readonly passwordUnlocked = signal(false);

  // ─── Loading State Signals ──────────────────────────────────────────────────

  readonly isCheckingRclone = signal(false);
  readonly isCheckingMountPlugin = signal(false);
  readonly isCheckingEncryption = signal(false);

  // ─── Computed Values ────────────────────────────────────────────────────────

  /** List of current problems requiring attention */
  readonly problems = computed<SystemProblem[]>(() => {
    const list: SystemProblem[] = [];

    if (this.rcloneInstalled() === false) {
      list.push('rclone-missing');
    }
    if (this.mountPluginInstalled() === false) {
      list.push('mount-plugin-missing');
    }
    if (this.configEncrypted() === true && !this.passwordUnlocked()) {
      list.push('password-required');
    }

    return list;
  });

  /** Whether there are any active problems */
  readonly hasProblems = computed(() => this.problems().length > 0);

  /** Whether all initial checks have completed */
  readonly isInitialized = computed(
    () =>
      this.rcloneInstalled() !== null &&
      this.mountPluginInstalled() !== null &&
      this.configEncrypted() !== null
  );

  /** Whether any check is currently in progress */
  readonly isLoading = computed(
    () => this.isCheckingRclone() || this.isCheckingMountPlugin() || this.isCheckingEncryption()
  );

  /** Whether password is required (config encrypted and not unlocked) */
  readonly passwordRequired = computed(
    () => this.configEncrypted() === true && !this.passwordUnlocked()
  );

  // ─── Public Methods ─────────────────────────────────────────────────────────

  /**
   * Run all system checks. Call this during app initialization.
   */
  async runAllChecks(): Promise<void> {
    await Promise.all([this.checkRclone(), this.checkMountPlugin(), this.checkConfigEncryption()]);
  }

  /**
   * Check if rclone is installed and accessible
   */
  async checkRclone(): Promise<boolean> {
    this.isCheckingRclone.set(true);
    try {
      const installed = await this.systemInfoService.isRcloneAvailable();
      this.rcloneInstalled.set(installed);
      return installed;
    } catch (error) {
      console.error('Error checking rclone:', error);
      this.rcloneInstalled.set(false);
      return false;
    } finally {
      this.isCheckingRclone.set(false);
    }
  }

  /**
   * Check if mount plugin is installed
   */
  async checkMountPlugin(): Promise<boolean> {
    this.isCheckingMountPlugin.set(true);
    try {
      const installed = await this.installationService.isMountPluginInstalled();
      this.mountPluginInstalled.set(installed);
      return installed;
    } catch (error) {
      console.error('Error checking mount plugin:', error);
      this.mountPluginInstalled.set(false);
      return false;
    } finally {
      this.isCheckingMountPlugin.set(false);
    }
  }

  /**
   * Check if config is encrypted and try auto-unlock with stored password
   */
  async checkConfigEncryption(): Promise<boolean> {
    this.isCheckingEncryption.set(true);
    try {
      const encrypted = await this.rclonePasswordService.isConfigEncrypted();
      this.configEncrypted.set(encrypted);

      if (encrypted) {
        const storedPassword = await this.rclonePasswordService.getStoredPassword();
        if (storedPassword) {
          try {
            await this.rclonePasswordService.validatePassword(storedPassword);
            await this.rclonePasswordService.setConfigPasswordEnv(storedPassword);
            this.passwordUnlocked.set(true);
            console.log('Config auto-unlocked with stored password');
          } catch {
            console.debug('Stored password validation failed, manual entry required');
            this.passwordUnlocked.set(false);
          }
        }
      } else {
        // Not encrypted, no password needed
        this.passwordUnlocked.set(true);
      }

      return encrypted;
    } catch (error) {
      console.error('Error checking config encryption:', error);
      this.configEncrypted.set(null);
      return false;
    } finally {
      this.isCheckingEncryption.set(false);
    }
  }

  /**
   * Mark password as successfully unlocked for this session
   */
  markPasswordUnlocked(): void {
    this.passwordUnlocked.set(true);
  }

  /**
   * Mark rclone as installed (after successful installation)
   */
  markRcloneInstalled(): void {
    this.rcloneInstalled.set(true);
  }

  /**
   * Mark mount plugin as installed (after successful installation)
   */
  markMountPluginInstalled(): void {
    this.mountPluginInstalled.set(true);
  }

  /**
   * Reset all state (useful for testing or re-initialization)
   */
  reset(): void {
    this.rcloneInstalled.set(null);
    this.mountPluginInstalled.set(null);
    this.configEncrypted.set(null);
    this.passwordUnlocked.set(false);
  }
  // ─── Sheet Management ───────────────────────────────────────────────────────

  async showRepairSheet(data: RepairData): Promise<void> {
    const sheetRef = this.bottomSheet.open(RepairSheetComponent, {
      data,
      disableClose: true,
    });

    this.activeSheets.add(sheetRef);

    sheetRef.afterDismissed().subscribe(() => {
      this.activeSheets.delete(sheetRef);
    });
  }

  async openRepairSheetWithResult(data: RepairData): Promise<PasswordPromptResult | null> {
    const sheetRef = this.bottomSheet.open(RepairSheetComponent, {
      data,
      disableClose: true,
    });

    this.activeSheets.add(sheetRef);

    try {
      const result = await firstValueFrom(sheetRef.afterDismissed());
      return (result as PasswordPromptResult) ?? null;
    } catch (error) {
      console.error('Error in repair sheet:', error);
      return null;
    } finally {
      this.activeSheets.delete(sheetRef);
    }
  }

  hasActiveSheetOfType(type: RepairSheetType): boolean {
    return Array.from(this.activeSheets).some(
      sheet => sheet.instance instanceof RepairSheetComponent && sheet.instance.data?.type === type
    );
  }

  closeSheetsByType(type: RepairSheetType): void {
    Array.from(this.activeSheets).forEach(sheet => {
      if (sheet.instance instanceof RepairSheetComponent && sheet.instance.data?.type === type) {
        sheet.dismiss();
      }
    });
  }

  closeSheetsByTypes(types: RepairSheetType[]): void {
    Array.from(this.activeSheets).forEach(sheet => {
      if (
        sheet.instance instanceof RepairSheetComponent &&
        types.includes(sheet.instance.data?.type as RepairSheetType)
      ) {
        sheet.dismiss();
      }
    });
  }

  // ─── Specific Repair Flows ──────────────────────────────────────────────────

  handleRclonePathError(alreadyReported: boolean): void {
    if (alreadyReported) return;

    this.showRepairSheet({
      type: RepairSheetType.RCLONE_PATH,
    });
  }

  async handlePasswordRequired(isPromptInProgress: boolean): Promise<boolean> {
    if (isPromptInProgress || this.hasActiveSheetOfType(RepairSheetType.RCLONE_PASSWORD)) {
      console.debug('Password prompt already in progress, skipping...');
      return false;
    }

    try {
      const result = await this.promptForPassword();
      if (result?.password) {
        await this.rclonePasswordService.setConfigPasswordEnv(result.password);
        this.markPasswordUnlocked();
        console.debug('Password set successfully');
        return true;
      } else {
        console.debug('Password prompt was cancelled or no password provided');
        return false;
      }
    } catch (error) {
      console.error('Error handling password requirement:', error);
      throw error;
    }
  }

  async promptForPassword(): Promise<PasswordPromptResult | null> {
    const repairData: RepairData = {
      type: RepairSheetType.RCLONE_PASSWORD,
      requiresPassword: true,
      showStoreOption: true,
      passwordDescription:
        'Your rclone configuration requires a password to access encrypted remotes.',
    };

    return this.openRepairSheetWithResult(repairData);
  }

  // ─── Event Handling Logic ───────────────────────────────────────────────────

  async handleRcloneOAuthEvent(event: object, isOnboardingCompleted: boolean): Promise<void> {
    console.debug('OAuth event received:', event);

    try {
      if ('status' in event) {
        const typedEvent = event as { status: string; message?: string };
        switch (typedEvent.status) {
          case 'password_error':
            console.debug('🔑 OAuth password error detected:', typedEvent.message);
            if (isOnboardingCompleted) {
              await this.handlePasswordRequired(false);
            }
            break;

          case 'spawn_failed':
            console.error('🚫 OAuth process failed to start:', typedEvent.message);
            break;

          case 'startup_timeout':
            console.error('⏰ OAuth process startup timeout:', typedEvent.message);
            break;

          case 'success':
            console.debug('✅ OAuth process started successfully:', typedEvent.message);
            break;

          default:
            console.debug(`Unhandled OAuth event status: ${typedEvent.status}`);
            break;
        }
      } else {
        console.warn('Unknown OAuth event format:', event);
      }
    } catch (error) {
      console.error('Error handling OAuth event:', error);
    }
  }

  setupMountPluginListener(): void {
    this.eventListenersService.listenToMountPluginInstalled().subscribe(() => {
      console.debug('Mount plugin installation event received');
      // Re-check mount plugin status after a short delay
      setTimeout(async () => {
        await this.recheckMountPluginStatus();
      }, 1000);
    });
  }

  private async recheckMountPluginStatus(): Promise<void> {
    try {
      const mountPluginOk = await this.installationService.isMountPluginInstalled(1);
      console.debug('Mount plugin re-check status:', mountPluginOk);

      if (mountPluginOk) {
        this.markMountPluginInstalled();
        this.closeSheetsByType(RepairSheetType.MOUNT_PLUGIN);
      } else {
        console.warn('Mount plugin installation event received but plugin still not detected');
      }
    } catch (error) {
      console.error('Error re-checking mount plugin status:', error);
      // Still close the sheet as the installation event was likely user-initiated
      this.closeSheetsByType(RepairSheetType.MOUNT_PLUGIN);
    }
  }
}
