import { Component, inject, NgZone } from '@angular/core';
import { MAT_BOTTOM_SHEET_DATA, MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { MatListModule } from '@angular/material/list';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatRadioModule } from '@angular/material/radio';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RepairData } from '../../../shared/components/types';
import { RepairService } from '../../../services/file-operations/repair.service';
import { AppSettingsService } from '../../../services/settings/app-settings.service';
import { AnimationsService } from '../../../services/core/animations.service';
import {
  InstallationOptionsComponent,
  InstallationOptionsData,
} from '../../../shared/components/installation-options/installation-options.component';

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
    FormsModule,
    ReactiveFormsModule,
    MatTooltipModule,
    InstallationOptionsComponent,
  ],
  animations: [AnimationsService.slideInOut()],
  templateUrl: './repair-sheet.component.html',
  styleUrl: './repair-sheet.component.scss',
})
export class RepairSheetComponent {
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

  public data = inject<RepairData>(MAT_BOTTOM_SHEET_DATA);
  private sheetRef = inject(MatBottomSheetRef<RepairSheetComponent>);
  private zone = inject(NgZone);
  private repairService = inject(RepairService);
  private appSettingsService = inject(AppSettingsService);

  constructor() {
    // No setup needed - shared component handles everything
  }

  async repair(): Promise<void> {
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

      // Close the sheet after successful repair
      setTimeout(() => {
        this.sheetRef.dismiss('success');
      }, 1000);
    } catch (error) {
      console.error('Repair failed:', error);
      // Show error state or keep sheet open for retry
    }

    this.zone.run(() => (this.installing = false));
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
    if (this.installing) {
      return false;
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
}
