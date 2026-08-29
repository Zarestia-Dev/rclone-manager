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
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import {
  BinaryStatus,
  InstallationOptionsData,
  RepairData,
  RepairMode,
  CONFIG_TAB_OPTIONS,
  DEFAULT_INSTALLATION_DATA,
} from '@app/types';
import { InstallationOptionsComponent } from '../../../shared/components/installation-options/installation-options.component';
import { PasswordManagerComponent } from '../../../shared/components/password-manager/password-manager.component';
import { ProvisionProgressComponent } from '../../../shared/components/provision-progress/provision-progress.component';
import { AlertBannerComponent } from '../../../shared/components/alert-banner/alert-banner.component';
import { RclonePasswordService } from 'src/app/services/security/rclone-password.service';
import { RepairService } from 'src/app/services/operations/repair.service';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { SystemInfoService } from 'src/app/services/infrastructure/system/system-info.service';
import { BackendService } from '../../../services/infrastructure/system/backend.service';
import { ModalService } from 'src/app/services/ui/modal.service';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { BackendTranslationService } from 'src/app/services/i18n/backend-translation.service';

@Component({
  selector: 'app-repair-sheet',
  imports: [
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    InstallationOptionsComponent,
    PasswordManagerComponent,
    ProvisionProgressComponent,
    AlertBannerComponent,
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
  readonly isSuggestingPort = signal(false);
  private readonly messageOverride = signal<string | null>(null);

  readonly data = inject<RepairData>(MAT_BOTTOM_SHEET_DATA);
  readonly selectedPort = signal<number>(this.data.port ?? 51900);
  private readonly sheetRef = inject(MatBottomSheetRef<RepairSheetComponent>);
  private readonly repairService = inject(RepairService);

  readonly rcloneProgress = this.repairService.rcloneProgress;
  readonly mountPluginProgress = this.repairService.mountPluginProgress;

  readonly activeProgress = computed(() => {
    if (this.isMountPluginRepair()) {
      return this.mountPluginProgress();
    }
    if (this.isRcloneBinaryRepair() || this.data.type === 'rclone_version') {
      return this.rcloneProgress();
    }
    return null;
  });
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly passwordService = inject(RclonePasswordService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly backendService = inject(BackendService);
  private readonly modalService = inject(ModalService);
  private readonly systemInfoService = inject(SystemInfoService);
  private readonly backendTranslation = inject(BackendTranslationService);

  readonly isTestingPort = signal<boolean>(false);
  readonly portTestResult = signal<'untested' | 'available' | 'occupied'>(
    this.data.type === 'rclone_port' ? 'occupied' : 'untested'
  );

  readonly configTabOptions = CONFIG_TAB_OPTIONS;
  readonly minRcloneVersion = this.systemInfoService.minRcloneVersion;

  readonly isRemoteBackend = computed(() => {
    if (this.data.isRemote !== undefined) return this.data.isRemote;
    return !this.backendService.isLocalBackend();
  });

  readonly isRemoteAuthRepair = computed(
    () => this.data.type === 'rclone_auth' && this.isRemoteBackend()
  );

  readonly isRcloneBinaryRepair = computed(
    () => this.data.type === 'rclone_binary' || this.data.type === 'rclone_version'
  );
  readonly isMountPluginRepair = computed(() => this.data.type === 'mount_plugin');
  readonly isRclonePortRepair = computed(() => this.data.type === 'rclone_port');
  readonly requiresPassword = computed(
    () => this.data.type === 'rclone_password' || this.data.requiresPassword === true
  );
  readonly canSubmitPassword = computed(() => !!this.password() && !this.isSubmittingPassword());

  readonly portInputError = computed(() => {
    const port = this.selectedPort();
    if (!port || isNaN(port) || port < 1024 || port > 65535) {
      return 'repairSheet.portConfig.invalidPort';
    }
    return '';
  });

  readonly currentMode = computed((): RepairMode => {
    if (this.showConfigOptions()) return 'config';
    if (this.isRcloneBinaryRepair() && this.showAdvanced()) return 'install';
    return 'standard';
  });

  readonly isProcessing = computed(
    () =>
      this.installing() ||
      this.isSubmittingPassword() ||
      this.isRefreshingStatus() ||
      this.isSuggestingPort() ||
      this.isTestingPort()
  );

  readonly repairIcon = computed(() =>
    this.repairService.getRepairButtonIcon(this.data.type, this.isRemoteBackend())
  );
  readonly repairDetails = computed(() =>
    this.repairService.getRepairDetails(this.data.type, this.isRemoteBackend())
  );

  readonly displayTitle = computed(
    () =>
      this.data.title ??
      this.translate.instant(
        this.repairService.getRepairTitleKey(this.data.type, this.isRemoteBackend()),
        {
          required: this.minRcloneVersion(),
          port: this.data.port ?? 51900,
        }
      )
  );

  readonly displayMessage = computed(
    () =>
      this.messageOverride() ??
      this.data.message ??
      this.translate.instant(
        this.repairService.getRepairMessageKey(this.data.type, this.isRemoteBackend()),
        {
          required: this.minRcloneVersion(),
          port: this.data.port ?? 51900,
        }
      )
  );

  readonly canRepair = computed(() => {
    if (this.isProcessing()) return false;
    if (this.isRclonePortRepair()) {
      return (
        !this.portInputError() && !!this.selectedPort() && this.portTestResult() !== 'occupied'
      );
    }
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
    if (this.isRclonePortRepair()) return 'rotate-right';
    if (this.isRemoteAuthRepair()) return 'lock';
    return this.repairService.getRepairButtonIcon(this.data.type, this.isRemoteBackend());
  });

  readonly repairActionTextKey = computed(() => {
    if (this.isSubmittingPassword()) return 'repairSheet.validatingPassword';
    if (this.installing()) return this.repairProgressTextKey();
    return this.repairButtonTextKey();
  });

  private readonly repairButtonTextKey = computed(() => {
    if (this.isRclonePortRepair()) return 'repairSheet.actions.changePort';
    if (this.isRemoteAuthRepair()) return 'repairSheet.actions.configureBackend';
    if (this.showConfigOptions()) return this.getConfigModeButtonTextKey();
    if (this.requiresPassword() && !this.password()) return 'repairSheet.buttons.enterPassword';
    if (this.isRcloneBinaryRepair() && this.showAdvanced())
      return this.getInstallModeButtonTextKey();
    return this.repairService.getRepairButtonTextKey(this.data.type, this.isRemoteBackend());
  });

  private readonly repairProgressTextKey = computed(() => {
    if (
      this.currentMode() === 'install' &&
      this.installationData().installLocation === 'existing'
    ) {
      return 'repairSheet.progress.configuring';
    }
    return this.repairService.getRepairProgressTextKey(this.data.type, this.isRemoteBackend());
  });

  readonly repairTooltip = computed(() => {
    if (this.canRepair() || this.isProcessing()) return '';

    if (this.isRclonePortRepair()) {
      if (this.portInputError()) return 'repairSheet.portConfig.invalidPort';
      if (this.portTestResult() === 'occupied') return 'repairSheet.portConfig.portOccupiedTooltip';
      return '';
    }

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

  onPortChange(event: Event): void {
    const val = Number((event.target as HTMLInputElement).value);
    this.selectedPort.set(val);
    if (this.data.type === 'rclone_port' && val === this.data.port) {
      this.portTestResult.set('occupied');
    } else {
      this.portTestResult.set('untested');
    }
  }

  async suggestNextPort(): Promise<void> {
    this.isSuggestingPort.set(true);
    this.portTestResult.set('untested');
    try {
      const start = (this.selectedPort() || 51900) + 1;
      const next = await this.repairService.findNextAvailablePort(start);
      this.selectedPort.set(next);
      this.portTestResult.set('available');
    } catch (err) {
      console.error('Failed to find next available port:', err);
    } finally {
      this.isSuggestingPort.set(false);
    }
  }

  async testPort(): Promise<void> {
    if (this.portInputError() || !this.selectedPort()) return;
    this.isTestingPort.set(true);
    try {
      const isAvailable = await this.repairService.checkPortAvailable(this.selectedPort());
      this.portTestResult.set(isAvailable ? 'available' : 'occupied');
    } catch (err) {
      console.error('Failed to test port availability:', err);
      this.portTestResult.set('occupied');
    } finally {
      this.isTestingPort.set(false);
    }
  }

  @HostListener('document:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void this.repair();
    }
  }

  async repair(): Promise<void> {
    if (!this.canRepair()) return;

    if (this.isRclonePortRepair()) {
      await this.executePortRepair();
      return;
    }

    if (this.isRemoteAuthRepair()) {
      this.sheetRef.dismiss();
      this.modalService.openBackend();
      return;
    }

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

  private async executePortRepair(): Promise<void> {
    this.installing.set(true);
    try {
      await this.repairService.repairRclonePort(this.selectedPort());
      this.dismissAfter('success', 1000);
    } catch (error) {
      console.error('Port repair failed:', error);
      const errorMsg = this.backendTranslation.translateBackendMessage(error);
      this.messageOverride.set(errorMsg);
    } finally {
      this.installing.set(false);
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

  private dismissAfter(result: unknown, delay: number): void {
    const id = setTimeout(() => this.sheetRef.dismiss(result), delay);
    this.destroyRef.onDestroy(() => clearTimeout(id));
  }

  private async executeConfigRepair(): Promise<void> {
    this.installing.set(true);
    try {
      const { installLocation, customPath } = this.installationData();
      const configPath = installLocation === 'custom' ? customPath : '';
      await this.backendService.updateLocalBackendConfigPath(configPath || undefined);
      this.dismissAfter('success', 1000);
    } catch (error) {
      console.error('Config repair failed:', error);
    } finally {
      this.installing.set(false);
    }
  }

  async cancelRepair(): Promise<void> {
    if (this.isMountPluginRepair()) {
      await this.repairService.cancelMountPluginRepair();
    } else if (this.isRcloneBinaryRepair() || this.data.type === 'rclone_version') {
      await this.repairService.cancelRcloneRepair();
    }
    this.installing.set(false);
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
      if (this.isMountPluginRepair() && !this.repairService.isCancellationError(error)) {
        const errorMsg = this.backendTranslation.translateBackendMessage(error);
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
      const labels: Record<BinaryStatus, string> = {
        untested: 'repairSheet.buttons.testBinaryFirst',
        testing: 'repairSheet.buttons.testingBinary',
        valid: 'repairSheet.buttons.useThisBinary',
        invalid: 'repairSheet.buttons.invalidBinary',
      };
      return labels[binaryTestResult];
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
