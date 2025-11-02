import { Component, inject, NgZone, ChangeDetectorRef } from '@angular/core';
import { MAT_BOTTOM_SHEET_DATA, MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { MatListModule } from '@angular/material/list';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatRadioModule } from '@angular/material/radio';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { MatTooltipModule } from '@angular/material/tooltip';
import { InstallationOptionsData, RepairData, InstallationTabOption } from '@app/types';
import { InstallationOptionsComponent } from '../../../shared/components/installation-options/installation-options.component';
import { PasswordManagerComponent } from '../../../shared/components/password-manager/password-manager.component';
import {
  RclonePasswordService,
  RepairService,
  InstallationService,
  AppSettingsService,
} from '@app/services';
import { AnimationsService } from '../../../shared/services/animations.service';

type RepairMode = 'standard' | 'install' | 'config';

@Component({
  selector: 'app-repair-sheet',
  standalone: true,
  imports: [
    MatListModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatRadioModule,
    MatCheckboxModule,
    MatProgressSpinnerModule,
    FormsModule,
    ReactiveFormsModule,
    MatTooltipModule,
    InstallationOptionsComponent,
    PasswordManagerComponent,
  ],
  animations: [AnimationsService.slideInOut()],
  templateUrl: './repair-sheet.component.html',
  styleUrl: './repair-sheet.component.scss',
})
export class RepairSheetComponent {
  // State flags
  installing = false;
  showAdvanced = false;
  showConfigOptions = false;
  isRefreshingStatus = false;

  // Installation configuration
  installationData: InstallationOptionsData = {
    installLocation: 'default',
    customPath: '',
    existingBinaryPath: '',
    binaryTestResult: 'untested',
  };
  installationValid = true;

  // Password state
  password = '';
  storePassword = true;
  isSubmittingPassword = false;
  hasPasswordError = false;
  passwordErrorMessage = '';
  errorCount = 0;

  // Tab configurations
  readonly configTabOptions: InstallationTabOption[] = [
    { key: 'default', label: 'Default Config', icon: 'bolt' },
    { key: 'custom', label: 'Custom Config', icon: 'file' },
  ];

  // Dependency injection
  readonly data = inject<RepairData>(MAT_BOTTOM_SHEET_DATA);
  private readonly sheetRef = inject(MatBottomSheetRef<RepairSheetComponent>);
  private readonly zone = inject(NgZone);
  private readonly repairService = inject(RepairService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly passwordService = inject(RclonePasswordService);
  private readonly installationService = inject(InstallationService);
  private readonly cdr = inject(ChangeDetectorRef);

  // Computed properties
  get currentMode(): RepairMode {
    if (this.showConfigOptions) return 'config';
    if (this.isRclonePathRepair() && this.showAdvanced) return 'install';
    return 'standard';
  }

  get isProcessing(): boolean {
    return this.installing || this.isSubmittingPassword || this.isRefreshingStatus;
  }

  // Main repair handler
  async repair(): Promise<void> {
    if (!this.canRepair()) return;

    switch (this.currentMode) {
      case 'config':
        await this.executeConfigRepair();
        break;
      case 'standard':
        if (this.requiresPassword() && this.password) {
          await this.submitPassword();
        } else if (this.requiresPassword()) {
          this.showPasswordError('Password is required, or select a different config file.');
        } else {
          await this.executeRepair();
        }
        break;
      case 'install':
        await this.executeRepair();
        break;
    }
  }

  // UI state methods
  getRepairIcon(): string {
    return this.repairService.getRepairButtonIcon(this.data.type);
  }

  getRepairDetails(): { icon: string; label: string; value: string }[] | null {
    return this.repairService.getRepairDetails(this.data.type);
  }

  getRepairButtonText(): string {
    if (this.installing) {
      return this.repairService.getRepairProgressText(this.data.type);
    }

    if (this.showConfigOptions) {
      return this.getConfigModeButtonText();
    }

    if (this.requiresPassword() && !this.password) {
      return 'Enter Password';
    }

    if (this.isRclonePathRepair() && this.showAdvanced) {
      return this.getInstallModeButtonText();
    }

    return this.repairService.getRepairButtonText(this.data.type);
  }

  getRepairProgressText(): string {
    if (this.currentMode === 'install' && this.installationData.installLocation === 'existing') {
      return 'Configuring...';
    }
    return this.repairService.getRepairProgressText(this.data.type);
  }

  getRepairButtonIcon(): string {
    if (this.isProcessing) {
      return this.installing ? 'refresh' : 'download';
    }
    if (this.showConfigOptions) {
      return 'file';
    }
    return this.repairService.getRepairButtonIcon(this.data.type);
  }

  canRepair(): boolean {
    if (this.isProcessing) return false;

    switch (this.currentMode) {
      case 'config':
      case 'install':
        return this.installationValid;
      case 'standard':
        return this.requiresPassword() ? this.canSubmitPassword() : true;
    }
  }

  // Toggle methods
  toggleInstallOptions(): void {
    this.zone.run(() => {
      this.showAdvanced = !this.showAdvanced;
      if (!this.showAdvanced) {
        this.resetInstallationOptions();
      }
    });
  }

  toggleConfigOptions(): void {
    this.zone.run(() => {
      this.showConfigOptions = !this.showConfigOptions;
      if (!this.showConfigOptions) {
        this.resetInstallationOptions();
      }
    });
  }

  // Type checking helpers
  isRclonePathRepair(): boolean {
    return this.data.type === 'rclone_path';
  }

  isMountPluginRepair(): boolean {
    return this.data.type === 'mount_plugin';
  }

  requiresPassword(): boolean {
    return this.data.type === 'rclone_password' || this.data.requiresPassword === true;
  }

  // Installation options handlers
  onInstallationOptionsChange(data: InstallationOptionsData): void {
    this.installationData = { ...data };
  }

  onInstallationValidChange(valid: boolean): void {
    this.installationValid = valid;
  }

  // Password methods
  async submitPassword(): Promise<void> {
    if (!this.password || this.isSubmittingPassword) return;

    this.isSubmittingPassword = true;
    this.clearPasswordError();

    try {
      await this.passwordService.validatePassword(this.password);

      if (this.storePassword) {
        await this.passwordService
          .storePassword(this.password)
          .catch(err => console.warn('Failed to store password:', err));
      }

      await this.passwordService.setConfigPasswordEnv(this.password);
      this.password = '';
      await this.executeRepair();
    } catch (error) {
      this.handlePasswordError(error);
    } finally {
      this.isSubmittingPassword = false;
    }
  }

  canSubmitPassword(): boolean {
    return !!(this.password && !this.isSubmittingPassword);
  }

  // Mount plugin status refresh
  async refreshMountPluginStatus(): Promise<void> {
    if (this.isRefreshingStatus) return;

    this.isRefreshingStatus = true;
    try {
      const isInstalled = await this.installationService.isMountPluginInstalled(1);

      if (isInstalled) {
        this.sheetRef.dismiss('success');
      } else {
        this.data.message = `Mount plugin status checked at ${new Date().toLocaleTimeString()}. Plugin not detected. You may need to restart the application if you recently installed it manually.`;
      }
    } catch (error) {
      console.error('Error refreshing mount plugin status:', error);
      this.data.message =
        'Error checking mount plugin status. Please try restarting the application.';
    } finally {
      this.isRefreshingStatus = false;
    }
  }

  dismiss(): void {
    this.sheetRef.dismiss();
  }

  // Private helper methods
  private async executeConfigRepair(): Promise<void> {
    this.zone.run(() => (this.installing = true));

    try {
      if (this.installationData.installLocation === 'default') {
        // Clear custom config path by setting empty string
        await this.appSettingsService.saveSetting('core', 'rclone_config_file', '');
      } else if (this.installationData.installLocation === 'custom') {
        // Set the custom config path
        await this.appSettingsService.saveSetting(
          'core',
          'rclone_config_file',
          this.installationData.customPath
        );
      }

      setTimeout(() => this.sheetRef.dismiss('success'), 1000);
    } catch (error) {
      console.error('Config repair failed:', error);
    } finally {
      this.zone.run(() => (this.installing = false));
    }
  }

  private async executeRepair(): Promise<void> {
    this.zone.run(() => (this.installing = true));

    try {
      if (this.currentMode === 'install') {
        await this.handleInstallModeRepair();
      } else {
        await this.repairService.executeRepair(this.data);
      }

      const delay = this.data.type === 'mount_plugin' ? 2000 : 1000;
      setTimeout(() => this.sheetRef.dismiss('success'), delay);
    } catch (error) {
      this.handleRepairError(error);
    } finally {
      this.zone.run(() => (this.installing = false));
    }
  }

  private async handleInstallModeRepair(): Promise<void> {
    if (this.installationData.installLocation === 'existing') {
      await this.appSettingsService.saveSetting(
        'core',
        'rclone_path',
        this.installationData.existingBinaryPath
      );
    } else {
      const installPath =
        this.installationData.installLocation === 'default'
          ? null
          : this.installationData.customPath;
      await this.repairService.repairRclonePath(installPath);
    }
  }

  private getConfigModeButtonText(): string {
    if (
      this.installationData.installLocation === 'custom' &&
      !this.installationData.customPath.trim()
    ) {
      return 'Select Config First';
    }
    return 'Use This Config';
  }

  private getInstallModeButtonText(): string {
    const { installLocation, customPath, existingBinaryPath, binaryTestResult } =
      this.installationData;

    if (installLocation === 'custom' && !customPath.trim()) {
      return 'Select Path First';
    }

    if (installLocation === 'existing') {
      if (!existingBinaryPath.trim()) return 'Select Binary First';
      if (binaryTestResult === 'invalid') return 'Invalid Binary';
      if (binaryTestResult === 'testing') return 'Testing Binary...';
      if (binaryTestResult === 'valid') return 'Use This Binary';
      return 'Test Binary First';
    }

    return this.repairService.getRepairButtonText(this.data.type);
  }

  private showPasswordError(message: string): void {
    this.hasPasswordError = true;
    this.passwordErrorMessage = message;
  }

  private clearPasswordError(): void {
    this.hasPasswordError = false;
    this.passwordErrorMessage = '';
  }

  private handlePasswordError(error: unknown): void {
    console.error('Password validation failed:', error);
    this.hasPasswordError = true;
    this.passwordErrorMessage = this.getPasswordErrorMessage(error);
    this.errorCount++;
    this.cdr.detectChanges();
  }

  private getPasswordErrorMessage(error: unknown): string {
    if (!(error instanceof Error)) {
      return 'Failed to validate password. Please try again.';
    }

    if (error.message.includes('invalid') || error.message.includes('wrong')) {
      return 'Invalid password. Please check your password and try again.';
    }
    if (error.message.includes('locked') || error.message.includes('attempt')) {
      return 'Too many failed attempts. Please wait before trying again.';
    }
    return error.message;
  }

  private handleRepairError(error: unknown): void {
    console.error('Repair failed:', error);

    if (this.data.type === 'mount_plugin' && error instanceof Error) {
      this.data.message = `Installation failed: ${error.message}. You may need administrator privileges or a system restart.`;
    }

    this.zone.run(() => (this.installing = false));
  }

  private resetInstallationOptions(): void {
    this.installationData = {
      installLocation: 'default',
      customPath: '',
      existingBinaryPath: '',
      binaryTestResult: 'untested',
    };
    this.installationValid = true;
  }
}
