import { Component, inject, NgZone, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
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
import { InstallationOptionsData, PasswordLockoutStatus, RepairData } from '@app/types';
import { InstallationOptionsComponent } from '../../../shared/components/installation-options/installation-options.component';
import { PasswordManagerComponent } from '../../../shared/components/password-manager/password-manager.component';

// Services
import { RclonePasswordService, RepairService, InstallationService } from '@app/services';
import { AppSettingsService } from '@app/services';
import { AnimationsService } from '../../../shared/services/animations.service';

@Component({
  selector: 'app-repair-sheet',
  standalone: true,
  imports: [
    CommonModule,
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
export class RepairSheetComponent implements OnInit {
  installing = false;
  showAdvanced = false;

  // Installation options data from shared component
  installationData: InstallationOptionsData = {
    installLocation: 'default',
    customPath: '',
    existingBinaryPath: '',
    binaryTestResult: 'untested',
  };
  installationValid = true;

  // Password-related properties
  password = '';
  storePassword = true;
  isSubmittingPassword = false;
  hasPasswordError = false;
  passwordErrorMessage = '';
  lockoutStatus: PasswordLockoutStatus | null = null;

  // Refresh status properties
  isRefreshingStatus = false;

  public data = inject<RepairData>(MAT_BOTTOM_SHEET_DATA);
  private sheetRef = inject(MatBottomSheetRef<RepairSheetComponent>);
  private zone = inject(NgZone);
  private repairService = inject(RepairService);
  private appSettingsService = inject(AppSettingsService);
  private passwordService = inject(RclonePasswordService);
  private installationService = inject(InstallationService);

  async ngOnInit(): Promise<void> {
    if (this.requiresPassword()) {
      await this.refreshLockoutStatus();
    }
  }

  async repair(): Promise<void> {
    // If this repair requires a password and we don't have one yet, validate it first
    if (this.requiresPassword() && !this.password) {
      // Show error that password is required
      this.hasPasswordError = true;
      this.passwordErrorMessage = 'Password is required to proceed with this repair.';
      return;
    }

    // If password is required, submit it first
    if (this.requiresPassword() && this.password) {
      await this.submitPassword();
      // The password validation flow will handle calling executeRepair
      return;
    }

    // For non-password repairs, proceed directly
    await this.executeRepair();
  }

  getRepairIcon(): string {
    return this.repairService.getRepairButtonIcon(this.data.type);
  }

  getRepairDetails(): { icon: string; label: string; value: string }[] | null {
    return this.repairService.getRepairDetails(this.data.type);
  }

  dismiss(): void {
    this.sheetRef.dismiss();
  }

  toggleAdvanced(): void {
    this.zone.run(() => {
      this.showAdvanced = !this.showAdvanced;
      if (!this.showAdvanced) {
        // Reset to default when hiding advanced options
        this.installationData = {
          installLocation: 'default',
          customPath: '',
          existingBinaryPath: '',
          binaryTestResult: 'untested',
        };
        this.installationValid = true;
      }
    });
  }

  onInstallationOptionsChange(data: InstallationOptionsData): void {
    this.installationData = { ...data };
  }

  onInstallationValidChange(valid: boolean): void {
    this.installationValid = valid;
  }

  canRepair(): boolean {
    if (this.installing || this.isSubmittingPassword || this.isRefreshingStatus) {
      return false;
    }

    // For password-required repairs, check if password is available or being submitted
    if (this.requiresPassword()) {
      return this.canSubmitPassword();
    }

    // For non-rclone repairs, always allow
    if (this.data.type !== 'rclone_path' || !this.showAdvanced) {
      return true;
    }

    // For rclone repairs with advanced options, check validity
    return this.installationValid;
  }

  getRepairButtonText(): string {
    if (this.installing) {
      return this.repairService.getRepairProgressText(this.data.type);
    }

    if (this.requiresPassword()) {
      if (!this.password) {
        return 'Enter Password';
      }
      return this.repairService.getRepairButtonText(this.data.type);
    }

    if (this.data.type === 'rclone_path' && this.showAdvanced) {
      if (
        this.installationData.installLocation === 'custom' &&
        this.installationData.customPath.trim().length === 0
      ) {
        return 'Select Path First';
      }
      if (this.installationData.installLocation === 'existing') {
        if (this.installationData.existingBinaryPath.trim().length === 0) {
          return 'Select Binary First';
        }
        if (this.installationData.binaryTestResult === 'invalid') {
          return 'Invalid Binary';
        }
        if (this.installationData.binaryTestResult === 'testing') {
          return 'Testing Binary...';
        }
        if (this.installationData.binaryTestResult === 'valid') {
          return 'Use This Binary';
        }
        return 'Test Binary First';
      }
    }

    return this.repairService.getRepairButtonText(this.data.type);
  }

  isRclonePathRepair(): boolean {
    return this.data.type === 'rclone_path';
  }

  isMountPluginRepair(): boolean {
    return this.data.type === 'mount_plugin';
  }

  async refreshMountPluginStatus(): Promise<void> {
    if (this.isRefreshingStatus) return;

    this.isRefreshingStatus = true;

    try {
      const isInstalled = await this.installationService.isMountPluginInstalled(1);

      if (isInstalled) {
        // Plugin is now installed, close the repair sheet
        this.sheetRef.dismiss('success');
      } else {
        // Update the message to indicate the status was checked
        const currentTime = new Date().toLocaleTimeString();
        this.data.message = `Mount plugin status checked at ${currentTime}. Plugin not detected. You may need to restart the application if you recently installed it manually.`;
      }
    } catch (error) {
      console.error('Error refreshing mount plugin status:', error);
      this.data.message =
        'Error checking mount plugin status. Please try restarting the application.';
    } finally {
      this.isRefreshingStatus = false;
    }
  }

  getRepairProgressText(): string {
    if (
      this.data.type === 'rclone_path' &&
      this.showAdvanced &&
      this.installationData.installLocation === 'existing'
    ) {
      return 'Configuring...';
    }
    return this.repairService.getRepairProgressText(this.data.type);
  }

  getRepairButtonIcon(): string {
    return this.repairService.getRepairButtonIcon(this.data.type);
  }

  // Password-related methods
  requiresPassword(): boolean {
    return this.data.type === 'rclone_password' || this.data.requiresPassword === true;
  }

  private async refreshLockoutStatus(): Promise<void> {
    try {
      this.lockoutStatus = await this.passwordService.getLockoutStatus();
    } catch (error) {
      console.error('Failed to get lockout status:', error);
    }
  }

  async submitPassword(): Promise<void> {
    if (!this.password || this.isSubmittingPassword || this.lockoutStatus?.is_locked) {
      return;
    }

    this.isSubmittingPassword = true;
    this.hasPasswordError = false;
    this.passwordErrorMessage = '';

    try {
      // Validate the password
      await this.passwordService.validatePassword(this.password);

      // If we get here, password validation was successful
      // Store password if requested
      if (this.storePassword) {
        try {
          await this.passwordService.storePassword(this.password);
        } catch (error) {
          console.warn('Failed to store password, but continuing with repair:', error);
        }
      }

      // Set password in environment for the repair process
      await this.passwordService.setConfigPasswordEnv(this.password);

      // Clear the password form for security
      this.password = '';

      // Now proceed with the actual repair
      await this.executeRepair();
    } catch (error) {
      console.error('Password validation failed:', error);
      this.hasPasswordError = true;
      this.passwordErrorMessage = this.getPasswordErrorMessage(error);
      await this.refreshLockoutStatus();
    } finally {
      this.isSubmittingPassword = false;
    }
  }

  canSubmitPassword(): boolean {
    return !!(this.password && !this.isSubmittingPassword && !this.lockoutStatus?.is_locked);
  }

  private getPasswordErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      if (error.message.includes('invalid') || error.message.includes('wrong')) {
        return 'Invalid password. Please check your password and try again.';
      }
      if (error.message.includes('locked') || error.message.includes('attempt')) {
        return 'Too many failed attempts. Please wait before trying again.';
      }
      return error.message;
    }
    return 'Failed to validate password. Please try again.';
  }

  private async executeRepair(): Promise<void> {
    // This is the original repair logic, now called after password is handled
    this.zone.run(() => (this.installing = true));

    try {
      if (this.data.type === 'rclone_path' && this.showAdvanced) {
        // Handle advanced rclone path repair options
        if (this.installationData.installLocation === 'existing') {
          // For existing binary, just save the path to settings
          await this.appSettingsService.saveSetting(
            'core',
            'rclone_path',
            this.installationData.existingBinaryPath
          );
        } else {
          // For default or custom installation
          const installPath =
            this.installationData.installLocation === 'default'
              ? null
              : this.installationData.customPath;
          await this.repairService.repairRclonePath(installPath);
        }
      } else {
        // Standard repair operation
        await this.repairService.executeRepair(this.data);
      }

      // For mount plugin installation, give extra time for the process to complete
      if (this.data.type === 'mount_plugin') {
        // Add additional delay for mount plugin installation
        setTimeout(() => {
          this.sheetRef.dismiss('success');
        }, 2000);
      } else {
        // Close the sheet after successful repair
        setTimeout(() => {
          this.sheetRef.dismiss('success');
        }, 1000);
      }
    } catch (error) {
      console.error('Repair failed:', error);

      // Show more specific error messages for mount plugin failures
      if (this.data.type === 'mount_plugin') {
        if (error instanceof Error) {
          // Update the data to show the error
          this.data.message = `Installation failed: ${error.message}. You may need administrator privileges or a system restart.`;
        }
      }

      // Keep the sheet open for retry and show error state
      this.zone.run(() => (this.installing = false));

      // Don't throw the error to prevent the sheet from closing
      return;
    }

    this.zone.run(() => (this.installing = false));
  }
}
