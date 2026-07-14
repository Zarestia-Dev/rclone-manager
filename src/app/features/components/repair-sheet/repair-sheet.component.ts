import {
  Component,
  inject,
  signal,
  computed,
  ChangeDetectionStrategy,
  DestroyRef,
  HostListener,
} from '@angular/core';
import { MAT_BOTTOM_SHEET_DATA, MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import {
  InstallationOptionsData,
  RepairData,
  RepairMode,
  CONFIG_TAB_OPTIONS,
  DEFAULT_INSTALLATION_DATA,
} from '@app/types';
import { InstallationOptionsComponent } from '../../../shared/components/installation-options/installation-options.component';
import { PasswordManagerComponent } from '../../../shared/components/password-manager/password-manager.component';
import { RclonePasswordService } from 'src/app/services/security/rclone-password.service';
import { RepairService } from 'src/app/services/operations/repair.service';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { SystemInfoService } from 'src/app/services/infrastructure/system/system-info.service';
import { BackendService } from '../../../services/infrastructure/system/backend.service';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { BackendTranslationService } from 'src/app/services/i18n/backend-translation.service';

@Component({
  selector: 'app-repair-sheet',
  imports: [
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    InstallationOptionsComponent,
    PasswordManagerComponent,
    TranslatePipe,
  ],
  templateUrl: './repair-sheet.component.html',
  styleUrl: './repair-sheet.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RepairSheetComponent {
  readonly installing = signal(false);
  readonly showAdvanced = signal(false);
  readonly showConfigOptions = signal(false);
  readonly isRefreshingStatus = signal(false);
  readonly installationData = signal<InstallationOptionsData>({ ...DEFAULT_INSTALLATION_DATA });
  readonly installationValid = signal(true);
  readonly password = signal('');
  readonly storePassword = signal(true);
  readonly isSubmittingPassword = signal(false);
  readonly hasPasswordError = signal(false);
  readonly passwordErrorMessage = signal('');
  private readonly messageOverride = signal<string | null>(null);

  readonly data = inject<RepairData>(MAT_BOTTOM_SHEET_DATA);
  private readonly sheetRef = inject(MatBottomSheetRef<RepairSheetComponent>);
  private readonly repairService = inject(RepairService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly passwordService = inject(RclonePasswordService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly backendService = inject(BackendService);
  private readonly systemInfoService = inject(SystemInfoService);
  private readonly backendTranslation = inject(BackendTranslationService);

  readonly configTabOptions = CONFIG_TAB_OPTIONS;
  readonly minRcloneVersion = this.systemInfoService.minRcloneVersion;

  readonly isRcloneBinaryRepair = computed(
    () => this.data.type === 'rclone_binary' || this.data.type === 'rclone_version'
  );
  readonly isMountPluginRepair = computed(() => this.data.type === 'mount_plugin');
  readonly requiresPassword = computed(
    () => this.data.type === 'rclone_password' || this.data.requiresPassword === true
  );
  readonly canSubmitPassword = computed(() => !!this.password() && !this.isSubmittingPassword());

  readonly currentMode = computed((): RepairMode => {
    if (this.showConfigOptions()) return 'config';
    if (this.isRcloneBinaryRepair() && this.showAdvanced()) return 'install';
    return 'standard';
  });

  readonly isProcessing = computed(
    () => this.installing() || this.isSubmittingPassword() || this.isRefreshingStatus()
  );

  readonly repairIcon = computed(() => this.repairService.getRepairButtonIcon(this.data.type));
  readonly repairDetails = computed(() => this.repairService.getRepairDetails(this.data.type));

  readonly displayTitle = computed(
    () =>
      this.data.title ??
      this.translate.instant(this.repairService.getRepairTitleKey(this.data.type), {
        required: this.minRcloneVersion(),
      })
  );

  readonly displayMessage = computed(
    () =>
      this.messageOverride() ??
      this.data.message ??
      this.translate.instant(this.repairService.getRepairMessageKey(this.data.type), {
        required: this.minRcloneVersion(),
      })
  );

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

  readonly repairButtonIcon = computed(() => {
    if (this.installing()) return 'spinner';
    if (this.isSubmittingPassword()) return 'download';
    if (this.showConfigOptions()) return 'file';
    return this.repairService.getRepairButtonIcon(this.data.type);
  });

  readonly repairActionTextKey = computed(() => {
    if (this.isSubmittingPassword()) return 'repairSheet.validatingPassword';
    if (this.installing()) return this.repairProgressTextKey();
    return this.repairButtonTextKey();
  });

  private readonly repairButtonTextKey = computed(() => {
    if (this.showConfigOptions()) return this.getConfigModeButtonTextKey();
    if (this.requiresPassword() && !this.password()) return 'repairSheet.buttons.enterPassword';
    if (this.isRcloneBinaryRepair() && this.showAdvanced())
      return this.getInstallModeButtonTextKey();
    return this.repairService.getRepairButtonTextKey(this.data.type);
  });

  private readonly repairProgressTextKey = computed(() => {
    if (
      this.currentMode() === 'install' &&
      this.installationData().installLocation === 'existing'
    ) {
      return 'repairSheet.progress.configuring';
    }
    return this.repairService.getRepairProgressTextKey(this.data.type);
  });

  readonly repairTooltip = computed(() => {
    if (this.canRepair() || this.isProcessing()) return '';

    const { installLocation, customPath, existingBinaryPath, binaryTestResult } =
      this.installationData();

    if (this.showConfigOptions()) {
      if (installLocation === 'custom' && !customPath.trim()) {
        return 'repairSheet.tooltips.selectConfigFirst';
      }
      return this.installationValid() ? '' : 'repairSheet.tooltips.fixValidationErrors';
    }

    if (this.requiresPassword()) {
      return this.password()
        ? 'repairSheet.tooltips.accountLocked'
        : 'repairSheet.tooltips.enterPasswordFirst';
    }

    if (installLocation === 'custom' && !customPath.trim()) {
      return 'repairSheet.tooltips.selectInstallPathFirst';
    }
    if (installLocation === 'existing') {
      if (!existingBinaryPath.trim()) return 'repairSheet.tooltips.selectBinaryFirst';
      if (binaryTestResult === 'invalid') return 'repairSheet.tooltips.invalidBinary';
      if (binaryTestResult === 'untested') return 'repairSheet.tooltips.testBinaryFirst';
    }
    return this.installationValid() ? '' : 'repairSheet.tooltips.fixValidationErrors';
  });

  @HostListener('document:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void this.repair();
    }
  }

  async repair(): Promise<void> {
    if (!this.canRepair()) return;

    switch (this.currentMode()) {
      case 'config':
        await this.executeConfigRepair();
        break;
      case 'install':
        await this.executeRepair();
        break;
      case 'standard':
        if (!this.requiresPassword()) {
          await this.executeRepair();
        } else if (this.password()) {
          await this.submitPassword();
        } else {
          this.hasPasswordError.set(true);
          this.passwordErrorMessage.set(
            this.translate.instant('repairSheet.errors.passwordRequired')
          );
        }
        break;
    }
  }

  toggleInstallOptions(): void {
    this.showAdvanced.update(v => !v);
    if (!this.showAdvanced()) this.resetInstallationOptions();
  }

  toggleConfigOptions(): void {
    this.showConfigOptions.update(v => !v);
    if (!this.showConfigOptions()) this.resetInstallationOptions();
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
    this.hasPasswordError.set(false);
    this.passwordErrorMessage.set('');

    try {
      const pwd = this.password();
      await this.passwordService.validatePassword(pwd);
      if (this.storePassword()) {
        await this.passwordService
          .storePassword(pwd)
          .catch(err => console.warn('Failed to store password:', err));
      } else {
        await this.passwordService.setConfigPasswordEnv(pwd);
      }
      this.password.set('');

      if (this.data.type === 'rclone_password') {
        this.dismissAfter({ password: pwd, stored: this.storePassword() }, 1000);
      } else {
        await this.executeRepair();
      }
    } catch (error) {
      this.hasPasswordError.set(true);
      this.passwordErrorMessage.set(this.getPasswordErrorMessage(error));
    } finally {
      this.isSubmittingPassword.set(false);
    }
  }

  dismiss(): void {
    this.sheetRef.dismiss();
  }

  private dismissAfter(result: any, delay: number): void {
    const id = setTimeout(() => this.sheetRef.dismiss(result), delay);
    this.destroyRef.onDestroy(() => clearTimeout(id));
  }

  private async executeConfigRepair(): Promise<void> {
    this.installing.set(true);
    try {
      const { installLocation, customPath } = this.installationData();
      const configPath = installLocation === 'custom' ? customPath : '';
      if (this.backendService.backends().length === 0) {
        await this.backendService.loadBackends();
      }
      const localBackend = this.backendService.backends().find(b => b.name === 'Local');
      if (localBackend) {
        await this.backendService.updateBackend({
          name: 'Local',
          host: localBackend.host,
          oauthHost: localBackend.oauthHost,
          port: localBackend.port,
          isLocal: true,
          username: localBackend.username,
          password: localBackend.password,
          configPath: configPath || undefined,
          oauthPort: localBackend.oauthPort,
        });
      }
      this.dismissAfter('success', 1000);
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
      this.dismissAfter('success', this.isMountPluginRepair() ? 2000 : 1000);
    } catch (error) {
      console.error('Repair failed:', error);
      if (this.isMountPluginRepair()) {
        const errorMsg =
          error instanceof Error
            ? error.message
            : this.backendTranslation.translateBackendMessage(error);
        this.messageOverride.set(
          this.translate.instant('repairSheet.errors.mountPluginInstallFailed', {
            error: errorMsg,
          })
        );
      }
    } finally {
      this.installing.set(false);
    }
  }

  private async handleInstallModeRepair(): Promise<void> {
    const { installLocation, existingBinaryPath, customPath } = this.installationData();
    if (installLocation === 'existing') {
      await this.appSettingsService.saveSetting('core', 'rclone_binary', existingBinaryPath);
    } else {
      await this.repairService.repairRclonePath(installLocation === 'default' ? null : customPath);
    }
  }

  private getConfigModeButtonTextKey(): string {
    const { installLocation, customPath } = this.installationData();
    return installLocation === 'custom' && !customPath.trim()
      ? 'repairSheet.buttons.selectConfigFirst'
      : 'repairSheet.buttons.useThisConfig';
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

  private resetInstallationOptions(): void {
    this.installationData.set({ ...DEFAULT_INSTALLATION_DATA });
    this.installationValid.set(true);
  }
}
