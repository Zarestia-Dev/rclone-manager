import {
  Component,
  inject,
  signal,
  computed,
  ChangeDetectionStrategy,
  DestroyRef,
} from '@angular/core';
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

const CONFIG_TAB_OPTIONS: InstallationTabOption[] = [
  { key: 'default', label: 'repairSheet.configTabs.default', icon: 'bolt' },
  { key: 'custom', label: 'repairSheet.configTabs.custom', icon: 'file' },
];

const DEFAULT_INSTALLATION_DATA: InstallationOptionsData = {
  installLocation: 'default',
  customPath: '',
  existingBinaryPath: '',
  binaryTestResult: 'untested',
};

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
  readonly installationData = signal<InstallationOptionsData>({ ...DEFAULT_INSTALLATION_DATA });
  readonly installationValid = signal(true);
  readonly password = signal('');
  readonly storePassword = signal(true);
  readonly isSubmittingPassword = signal(false);
  readonly hasPasswordError = signal(false);
  readonly passwordErrorMessage = signal('');
  private readonly messageOverride = signal<string | null>(null);

  // --- INJECTED DEPENDENCIES ---
  readonly data = inject<RepairData>(MAT_BOTTOM_SHEET_DATA);
  private readonly sheetRef = inject(MatBottomSheetRef<RepairSheetComponent>);
  private readonly repairService = inject(RepairService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly passwordService = inject(RclonePasswordService);
  private readonly installationService = inject(InstallationService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);

  // --- UI CONFIGURATION ---
  readonly configTabOptions = CONFIG_TAB_OPTIONS;

  // --- COMPUTED SIGNALS ---
  readonly isRclonePathRepair = computed(() => this.data.type === 'rclone_path');
  readonly isMountPluginRepair = computed(() => this.data.type === 'mount_plugin');
  readonly requiresPassword = computed(
    () => this.data.type === 'rclone_password' || this.data.requiresPassword === true
  );
  readonly canSubmitPassword = computed(() => !!this.password() && !this.isSubmittingPassword());

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

  readonly displayTitle = computed(
    () =>
      this.data.title ??
      this.translate.instant(this.repairService.getRepairTitleKey(this.data.type))
  );

  readonly displayMessage = computed(
    () =>
      this.messageOverride() ??
      this.data.message ??
      this.translate.instant(this.repairService.getRepairMessageKey(this.data.type))
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
    if (this.installing()) return 'refresh';
    if (this.isSubmittingPassword()) return 'download';
    if (this.showConfigOptions()) return 'file';
    return this.repairService.getRepairButtonIcon(this.data.type);
  });

  // Single source of truth for button text — replaces the triple-nested ternary in the template
  readonly repairActionTextKey = computed(() => {
    if (this.isSubmittingPassword()) return 'repairSheet.validatingPassword';
    if (this.installing()) return this.repairProgressTextKey();
    return this.repairButtonTextKey();
  });

  private readonly repairButtonTextKey = computed(() => {
    if (this.showConfigOptions()) return this.getConfigModeButtonTextKey();
    if (this.requiresPassword() && !this.password()) return 'repairSheet.buttons.enterPassword';
    if (this.isRclonePathRepair() && this.showAdvanced()) return this.getInstallModeButtonTextKey();
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

  // --- PUBLIC METHODS ---

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
      this.hasPasswordError.set(true);
      this.passwordErrorMessage.set(this.getPasswordErrorMessage(error));
    } finally {
      this.isSubmittingPassword.set(false);
    }
  }

  async refreshMountPluginStatus(): Promise<void> {
    if (this.isRefreshingStatus()) return;
    this.isRefreshingStatus.set(true);
    try {
      const isInstalled = await this.installationService.isMountPluginInstalled(1);
      if (isInstalled) {
        this.sheetRef.dismiss('success');
      } else {
        this.messageOverride.set(
          this.translate.instant('repairSheet.messages.mountPluginStatusChecked', {
            time: new Date().toLocaleTimeString(),
          })
        );
      }
    } catch {
      this.messageOverride.set(
        this.translate.instant('repairSheet.messages.mountPluginStatusError')
      );
    } finally {
      this.isRefreshingStatus.set(false);
    }
  }

  dismiss(): void {
    this.sheetRef.dismiss();
  }

  // --- PRIVATE METHODS ---

  // Centralised dismissal with leak-safe cleanup via DestroyRef
  private dismissAfter(result: string, delay: number): void {
    const id = setTimeout(() => this.sheetRef.dismiss(result), delay);
    this.destroyRef.onDestroy(() => clearTimeout(id));
  }

  private async executeConfigRepair(): Promise<void> {
    this.installing.set(true);
    try {
      const { installLocation, customPath } = this.installationData();
      const configPath = installLocation === 'custom' ? customPath : '';
      await this.appSettingsService.saveSetting('core', 'rclone_config_file', configPath);
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
      if (this.isMountPluginRepair() && error instanceof Error) {
        this.messageOverride.set(
          this.translate.instant('repairSheet.errors.mountPluginInstallFailed', {
            error: error.message,
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
      await this.appSettingsService.saveSetting('core', 'rclone_path', existingBinaryPath);
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
