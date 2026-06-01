import { DestroyRef, Injectable, signal, computed, inject } from '@angular/core';
import { MatBottomSheet, MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { EMPTY, firstValueFrom, from } from 'rxjs';
import { catchError, exhaustMap, filter } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RepairSheetComponent } from '../../../features/components/repair-sheet/repair-sheet.component';
import { RepairData, RepairSheetType, PasswordPromptResult } from '@app/types';
import { SystemInfoService } from '../system/system-info.service';
import { InstallationService } from '../../settings/installation.service';
import { RclonePasswordService } from '../../security/rclone-password.service';
import { EventListenersService } from '../system/event-listeners.service';

export type SystemProblem = 'rclone-missing' | 'mount-plugin-missing' | 'password-required';

@Injectable({ providedIn: 'root' })
export class SystemHealthService {
  private readonly systemInfoService = inject(SystemInfoService);
  private readonly installationService = inject(InstallationService);
  private readonly rclonePasswordService = inject(RclonePasswordService);
  private readonly eventListenersService = inject(EventListenersService);
  private readonly bottomSheet = inject(MatBottomSheet);
  private readonly destroyRef = inject(DestroyRef);

  private readonly activeSheets = new Set<MatBottomSheetRef<RepairSheetComponent>>();
  private hasReportedRclonePathError = false;
  private hasReportedRcloneVersionError = false;
  private onboardingCompleted = false;

  readonly rcloneInstalled = signal<boolean | null>(null);
  readonly mountPluginInstalled = signal<boolean | null>(null);
  readonly configEncrypted = signal<boolean | null>(null);
  readonly passwordUnlocked = signal(false);

  readonly isCheckingRclone = signal(false);
  readonly isCheckingMountPlugin = signal(false);
  readonly isCheckingEncryption = signal(false);

  readonly problems = computed<SystemProblem[]>(() => {
    const list: SystemProblem[] = [];
    if (this.rcloneInstalled() === false) list.push('rclone-missing');
    if (this.mountPluginInstalled() === false) list.push('mount-plugin-missing');
    if (this.configEncrypted() === true && !this.passwordUnlocked()) list.push('password-required');
    return list;
  });

  readonly hasProblems = computed(() => this.problems().length > 0);

  readonly isInitialized = computed(
    () =>
      this.rcloneInstalled() !== null &&
      this.mountPluginInstalled() !== null &&
      this.configEncrypted() !== null
  );

  readonly isLoading = computed(
    () => this.isCheckingRclone() || this.isCheckingMountPlugin() || this.isCheckingEncryption()
  );

  readonly passwordRequired = computed(
    () => this.configEncrypted() === true && !this.passwordUnlocked()
  );

  constructor() {
    this.setupRcloneEngineListeners();
  }

  async runAllChecks(): Promise<void> {
    await Promise.all([this.checkRclone(), this.checkMountPlugin(), this.checkConfigEncryption()]);
  }

  setOnboardingCompleted(completed: boolean): void {
    this.onboardingCompleted = completed;
  }

  async checkMountPluginAndPromptRepair(): Promise<void> {
    try {
      const ok = await this.checkMountPlugin();
      if (ok === false) {
        await this.showRepairSheet({ type: RepairSheetType.MOUNT_PLUGIN });
        this.setupMountPluginListener();
      }
    } catch (error) {
      console.error('Error checking mount plugin status:', error);
    }
  }

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

  async checkConfigEncryption(): Promise<boolean> {
    this.isCheckingEncryption.set(true);
    try {
      const encrypted = await this.rclonePasswordService.isConfigEncrypted();
      this.configEncrypted.set(encrypted);

      if (encrypted) {
        const stored = await this.rclonePasswordService.getStoredPassword();
        if (stored) {
          try {
            await this.rclonePasswordService.validatePassword(stored);
            await this.rclonePasswordService.setConfigPasswordEnv(stored);
            this.passwordUnlocked.set(true);
          } catch {
            this.passwordUnlocked.set(false);
          }
        }
      } else {
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

  markPasswordUnlocked(): void {
    this.passwordUnlocked.set(true);
  }

  markRcloneInstalled(): void {
    this.rcloneInstalled.set(true);
  }

  markMountPluginInstalled(): void {
    this.mountPluginInstalled.set(true);
  }

  reset(): void {
    this.rcloneInstalled.set(null);
    this.mountPluginInstalled.set(null);
    this.configEncrypted.set(null);
    this.passwordUnlocked.set(false);
  }

  showRepairSheet(data: RepairData): void {
    const sheetRef = this.bottomSheet.open(RepairSheetComponent, { data, disableClose: true });
    this.activeSheets.add(sheetRef);
    sheetRef.afterDismissed().subscribe(() => this.activeSheets.delete(sheetRef));
  }

  async openRepairSheetWithResult(data: RepairData): Promise<PasswordPromptResult | null> {
    const sheetRef = this.bottomSheet.open(RepairSheetComponent, { data, disableClose: true });
    this.activeSheets.add(sheetRef);
    try {
      return ((await firstValueFrom(sheetRef.afterDismissed())) as PasswordPromptResult) ?? null;
    } catch (error) {
      console.error('Error in repair sheet:', error);
      return null;
    } finally {
      this.activeSheets.delete(sheetRef);
    }
  }

  hasActiveSheetOfType(type: RepairSheetType): boolean {
    return [...this.activeSheets].some(
      s => s.instance instanceof RepairSheetComponent && s.instance.data?.type === type
    );
  }

  closeSheetsByType(...types: RepairSheetType[]): void {
    for (const sheet of this.activeSheets) {
      if (
        sheet.instance instanceof RepairSheetComponent &&
        types.includes(sheet.instance.data?.type as RepairSheetType)
      ) {
        sheet.dismiss();
      }
    }
  }

  handleRclonePathError(alreadyReported: boolean): void {
    if (alreadyReported) return;
    this.showRepairSheet({ type: RepairSheetType.RCLONE_BINARY });
  }

  handleRcloneVersionError(alreadyReported: boolean): void {
    if (alreadyReported) return;
    this.showRepairSheet({ type: RepairSheetType.RCLONE_VERSION });
  }

  async handlePasswordRequired(isPromptInProgress: boolean): Promise<boolean> {
    if (isPromptInProgress || this.hasActiveSheetOfType(RepairSheetType.RCLONE_PASSWORD)) {
      return false;
    }
    try {
      const result = await this.promptForPassword();
      if (result?.password) {
        await this.rclonePasswordService.setConfigPasswordEnv(result.password);
        this.markPasswordUnlocked();
        return true;
      }
      return false;
    } catch (error) {
      console.error('Error handling password requirement:', error);
      throw error;
    }
  }

  async promptForPassword(): Promise<PasswordPromptResult | null> {
    return this.openRepairSheetWithResult({
      type: RepairSheetType.RCLONE_PASSWORD,
      requiresPassword: true,
      showStoreOption: true,
      passwordDescription:
        'Your rclone configuration requires a password to access encrypted remotes.',
    });
  }

  async handleRcloneOAuthEvent(event: object, isOnboardingCompleted: boolean): Promise<void> {
    if (!('status' in event)) {
      console.warn('Unknown OAuth event format:', event);
      return;
    }

    const { status, message } = event as { status: string; message?: string };

    switch (status) {
      case 'password_error':
        if (isOnboardingCompleted) await this.handlePasswordRequired(false);
        break;
      case 'spawn_failed':
      case 'startup_timeout':
        console.error(`OAuth process error [${status}]:`, message);
        break;
      case 'success':
        console.debug('OAuth process started successfully:', message);
        break;
      default:
        console.debug(`Unhandled OAuth event status: ${status}`);
    }
  }

  private setupMountPluginListener(): void {
    this.eventListenersService
      .listenToMountPluginInstalled()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => setTimeout(() => void this.recheckMountPluginStatus(), 1000));
  }

  private async recheckMountPluginStatus(): Promise<void> {
    try {
      const ok = await this.installationService.isMountPluginInstalled(1);
      if (ok) {
        this.markMountPluginInstalled();
        this.closeSheetsByType(RepairSheetType.MOUNT_PLUGIN);
      } else {
        console.warn('Mount plugin install event received but plugin still not detected');
      }
    } catch (error) {
      console.error('Error re-checking mount plugin:', error);
      this.closeSheetsByType(RepairSheetType.MOUNT_PLUGIN);
    }
  }

  private setupRcloneEngineListeners(): void {
    this.eventListenersService
      .listenToRcloneEngineReady()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.hasReportedRclonePathError = false;
        this.hasReportedRcloneVersionError = false;
        this.closeSheetsByType(
          RepairSheetType.RCLONE_BINARY,
          RepairSheetType.RCLONE_VERSION,
          RepairSheetType.RCLONE_PASSWORD
        );
      });

    this.eventListenersService
      .listenToRcloneEnginePathError()
      .pipe(
        filter(() => this.onboardingCompleted),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(() => {
        this.handleRclonePathError(this.hasReportedRclonePathError);
        this.hasReportedRclonePathError = true;
      });

    this.eventListenersService
      .listenToRcloneEngineVersionError()
      .pipe(
        filter(() => this.onboardingCompleted),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(() => {
        this.handleRcloneVersionError(this.hasReportedRcloneVersionError);
        this.hasReportedRcloneVersionError = true;
      });

    this.eventListenersService
      .listenToRcloneEnginePasswordError()
      .pipe(
        filter(() => this.onboardingCompleted && !this.passwordUnlocked()),
        exhaustMap(() => from(this.handlePasswordRequired(false)).pipe(catchError(() => EMPTY))),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe();
  }
}
