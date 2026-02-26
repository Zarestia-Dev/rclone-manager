import { Component, inject, signal, computed, ChangeDetectionStrategy } from '@angular/core';
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
import { TranslateModule, TranslateService } from '@ngx-translate/core';

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
    TranslateModule,
  ],
  templateUrl: './repair-sheet.component.html',
  styleUrl: './repair-sheet.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RepairSheetComponent {
  // --- STATE SIGNALS ---
  readonly installing = signal(false);
  readonly showAdvanced = signal(false);
  readonly showConfigOptions = signal(false);
  readonly isRefreshingStatus = signal(false);
  readonly installationData = signal<InstallationOptionsData>({
    installLocation: 'default',
    customPath: '',
    existingBinaryPath: '',
    binaryTestResult: 'untested',
  });
  readonly installationValid = signal(true);
  readonly password = signal('');
  readonly storePassword = signal(true);
  readonly isSubmittingPassword = signal(false);
  readonly hasPasswordError = signal(false);
  readonly passwordErrorMessage = signal('');

  // --- INJECTED DEPENDENCIES ---
  readonly data = inject<RepairData>(MAT_BOTTOM_SHEET_DATA);
  private readonly sheetRef = inject(MatBottomSheetRef<RepairSheetComponent>);
  private readonly repairService = inject(RepairService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly passwordService = inject(RclonePasswordService);
  private readonly installationService = inject(InstallationService);
  private readonly translate = inject(TranslateService);

  // --- UI CONFIGURATION ---
  readonly configTabOptions: InstallationTabOption[] = [
    { key: 'default', label: 'repairSheet.configTabs.default', icon: 'bolt' },
    { key: 'custom', label: 'repairSheet.configTabs.custom', icon: 'file' },
  ];

  // --- COMPUTED SIGNALS ---
  readonly currentMode = computed((): RepairMode => {
    if (this.showConfigOptions()) return 'config';
    if (this.isRclonePathRepair() && this.showAdvanced()) return 'install';
    return 'standard';
  });

  readonly isProcessing = computed(
    () => this.installing() || this.isSubmittingPassword() || this.isRefreshingStatus()
  );

  readonly repairIcon = computed(() => this.repairService.getRepairButtonIcon(this.data.type));

  readonly repairDetails = computed(() => this.repairService.getRepairDetails(this.data.type));

  readonly repairButtonTextKey = computed(() => {
    if (this.installing()) {
      return this.repairService.getRepairProgressTextKey(this.data.type);
    }
    if (this.showConfigOptions()) {
      return this.getConfigModeButtonTextKey();
    }
    if (this.requiresPassword() && !this.password()) {
      return 'repairSheet.buttons.enterPassword';
    }
    if (this.isRclonePathRepair() && this.showAdvanced()) {
      return this.getInstallModeButtonTextKey();
    }
    return this.repairService.getRepairButtonTextKey(this.data.type);
  });

  readonly repairProgressTextKey = computed(() => {
    if (
      this.currentMode() === 'install' &&
      this.installationData().installLocation === 'existing'
    ) {
      return 'repairSheet.progress.configuring';
    }
    return this.repairService.getRepairProgressTextKey(this.data.type);
  });

  readonly repairButtonIcon = computed(() => {
    if (this.isProcessing()) {
      return this.installing() ? 'refresh' : 'download';
    }
    if (this.showConfigOptions()) {
      return 'file';
    }
    return this.repairService.getRepairButtonIcon(this.data.type);
  });

  readonly canRepair = computed(() => {
    if (this.isProcessing()) return false;
    switch (this.currentMode()) {
      case 'config':
      case 'install':
        return this.installationValid();
      case 'standard':
        return this.requiresPassword() ? this.canSubmitPassword() : true;
    }
  });

  readonly displayTitle = computed(() => {
    if (this.data.title) return this.data.title;
    return this.translate.instant(this.repairService.getRepairTitleKey(this.data.type));
  });

  readonly displayMessage = computed(() => {
    if (this.data.message) return this.data.message;
    return this.translate.instant(this.repairService.getRepairMessageKey(this.data.type));
  });

  readonly repairTooltip = computed(() => {
    if (this.canRepair() || this.installing() || this.isSubmittingPassword()) return '';

    const data = this.installationData();

    if (this.showConfigOptions()) {
      if (data.installLocation === 'custom' && !data.customPath.trim()) {
        return 'repairSheet.tooltips.selectConfigFirst';
      }
      if (!this.installationValid()) {
        return 'repairSheet.tooltips.fixValidationErrors';
      }
      return '';
    }

    if (this.requiresPassword()) {
      if (!this.password()) {
        return 'repairSheet.tooltips.enterPasswordFirst';
      }
      return 'repairSheet.tooltips.accountLocked';
    }

    if (data.installLocation === 'custom' && !data.customPath.trim()) {
      return 'repairSheet.tooltips.selectInstallPathFirst';
    }
    if (data.installLocation === 'existing') {
      if (!data.existingBinaryPath.trim()) return 'repairSheet.tooltips.selectBinaryFirst';
      if (data.binaryTestResult === 'invalid') return 'repairSheet.tooltips.invalidBinary';
      if (data.binaryTestResult === 'untested') return 'repairSheet.tooltips.testBinaryFirst';
    }
    if (!this.installationValid()) {
      return 'repairSheet.tooltips.fixValidationErrors';
    }
    return '';
  });

  // --- PUBLIC METHODS ---

  async repair(): Promise<void> {
    if (!this.canRepair()) return;

    switch (this.currentMode()) {
      case 'config':
        await this.executeConfigRepair();
        break;
      case 'standard':
        if (this.requiresPassword() && this.password()) {
          await this.submitPassword();
        } else if (this.requiresPassword()) {
          this.showPasswordError(this.translate.instant('repairSheet.errors.passwordRequired'));
        } else {
          await this.executeRepair();
        }
        break;
      case 'install':
        await this.executeRepair();
        break;
    }
  }

  toggleInstallOptions(): void {
    this.showAdvanced.update(v => !v);
    if (!this.showAdvanced()) {
      this.resetInstallationOptions();
    }
  }

  toggleConfigOptions(): void {
    this.showConfigOptions.update(v => !v);
    if (!this.showConfigOptions()) {
      this.resetInstallationOptions();
    }
  }

  isRclonePathRepair(): boolean {
    return this.data.type === 'rclone_path';
  }

  isMountPluginRepair(): boolean {
    return this.data.type === 'mount_plugin';
  }

  requiresPassword(): boolean {
    return this.data.type === 'rclone_password' || this.data.requiresPassword === true;
  }

  onInstallationOptionsChange(data: InstallationOptionsData): void {
    this.installationData.set({ ...data });
  }

  onInstallationValidChange(valid: boolean): void {
    this.installationValid.set(valid);
  }

  async submitPassword(): Promise<void> {
    if (!this.password() || this.isSubmittingPassword()) return;

    this.isSubmittingPassword.set(true);
    this.clearPasswordError();

    try {
      await this.passwordService.validatePassword(this.password());
      if (this.storePassword()) {
        await this.passwordService
          .storePassword(this.password())
          .catch(err => console.warn('Failed to store password:', err));
      }
      await this.passwordService.setConfigPasswordEnv(this.password());
      this.password.set('');
      await this.executeRepair();
    } catch (error) {
      this.handlePasswordError(error);
    } finally {
      this.isSubmittingPassword.set(false);
    }
  }

  canSubmitPassword(): boolean {
    return !!(this.password() && !this.isSubmittingPassword());
  }

  async refreshMountPluginStatus(): Promise<void> {
    if (this.isRefreshingStatus()) return;
    this.isRefreshingStatus.set(true);
    try {
      const isInstalled = await this.installationService.isMountPluginInstalled(1);
      if (isInstalled) {
        this.sheetRef.dismiss('success');
      } else {
        this.data.message = this.translate.instant(
          'repairSheet.messages.mountPluginStatusChecked',
          { time: new Date().toLocaleTimeString() }
        );
      }
    } catch (error) {
      console.error('Error refreshing mount plugin status:', error);
      this.data.message = this.translate.instant('repairSheet.messages.mountPluginStatusError');
    } finally {
      this.isRefreshingStatus.set(false);
    }
  }

  dismiss(): void {
    this.sheetRef.dismiss();
  }

  // --- PRIVATE METHODS ---

  private async executeConfigRepair(): Promise<void> {
    this.installing.set(true);
    try {
      if (this.installationData().installLocation === 'default') {
        await this.appSettingsService.saveSetting('core', 'rclone_config_file', '');
      } else if (this.installationData().installLocation === 'custom') {
        await this.appSettingsService.saveSetting(
          'core',
          'rclone_config_file',
          this.installationData().customPath
        );
      }
      setTimeout(() => this.sheetRef.dismiss('success'), 1000);
    } catch (error) {
      console.error('Config repair failed:', error);
    } finally {
      this.installing.set(false);
    }
  }

  private async executeRepair(): Promise<void> {
    this.installing.set(true);
    try {
      if (this.currentMode() === 'install') {
        await this.handleInstallModeRepair();
      } else {
        await this.repairService.executeRepair(this.data);
      }
      const delay = this.data.type === 'mount_plugin' ? 2000 : 1000;
      setTimeout(() => this.sheetRef.dismiss('success'), delay);
    } catch (error) {
      this.handleRepairError(error);
    } finally {
      this.installing.set(false);
    }
  }

  private async handleInstallModeRepair(): Promise<void> {
    const data = this.installationData();
    if (data.installLocation === 'existing') {
      await this.appSettingsService.saveSetting('core', 'rclone_path', data.existingBinaryPath);
    } else {
      const installPath = data.installLocation === 'default' ? null : data.customPath;
      await this.repairService.repairRclonePath(installPath);
    }
  }

  private getConfigModeButtonTextKey(): string {
    const data = this.installationData();
    if (data.installLocation === 'custom' && !data.customPath.trim()) {
      return 'repairSheet.buttons.selectConfigFirst';
    }
    return 'repairSheet.buttons.useThisConfig';
  }

  private getInstallModeButtonTextKey(): string {
    const { installLocation, customPath, existingBinaryPath, binaryTestResult } =
      this.installationData();
    if (installLocation === 'custom' && !customPath.trim()) {
      return 'repairSheet.buttons.selectPathFirst';
    }
    if (installLocation === 'existing') {
      if (!existingBinaryPath.trim()) return 'repairSheet.buttons.selectBinaryFirst';
      if (binaryTestResult === 'invalid') return 'repairSheet.buttons.invalidBinary';
      if (binaryTestResult === 'testing') return 'repairSheet.buttons.testingBinary';
      if (binaryTestResult === 'valid') return 'repairSheet.buttons.useThisBinary';
      return 'repairSheet.buttons.testBinaryFirst';
    }
    return this.repairService.getRepairButtonTextKey(this.data.type);
  }

  private showPasswordError(message: string): void {
    this.hasPasswordError.set(true);
    this.passwordErrorMessage.set(message);
  }

  private clearPasswordError(): void {
    this.hasPasswordError.set(false);
    this.passwordErrorMessage.set('');
  }

  private handlePasswordError(error: unknown): void {
    console.error('Password validation failed:', error);
    this.hasPasswordError.set(true);
    this.passwordErrorMessage.set(this.getPasswordErrorMessage(error));
  }

  private getPasswordErrorMessage(error: unknown): string {
    if (!(error instanceof Error)) {
      return this.translate.instant('repairSheet.passwordErrors.validateFailed');
    }
    if (error.message.includes('invalid') || error.message.includes('wrong')) {
      return this.translate.instant('repairSheet.passwordErrors.invalid');
    }
    if (error.message.includes('locked') || error.message.includes('attempt')) {
      return this.translate.instant('repairSheet.passwordErrors.locked');
    }
    return this.translate.instant('repairSheet.passwordErrors.generic', {
      error: error.message,
    });
  }

  private handleRepairError(error: unknown): void {
    console.error('Repair failed:', error);
    if (this.data.type === 'mount_plugin' && error instanceof Error) {
      this.data.message = this.translate.instant('repairSheet.errors.mountPluginInstallFailed', {
        error: error.message,
      });
    }
    this.installing.set(false);
  }

  private resetInstallationOptions(): void {
    this.installationData.set({
      installLocation: 'default',
      customPath: '',
      existingBinaryPath: '',
      binaryTestResult: 'untested',
    });
    this.installationValid.set(true);
  }
}
