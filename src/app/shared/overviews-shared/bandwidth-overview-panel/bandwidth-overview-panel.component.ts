import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  model,
} from '@angular/core';
import { ReactiveFormsModule, FormControl } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatDividerModule } from '@angular/material/divider';

import { BANDWIDTH_PRESETS, BandwidthDetailItem } from '@app/types';
import { FormatRateValuePipe } from '@app/pipes';
import { RcloneStatusService } from 'src/app/services/infrastructure/maintenance/rclone-status.service';
import { ValidatorRegistryService } from 'src/app/services/ui/validation/validator-registry.service';
import { NotificationService } from 'src/app/services/ui/notification.service';

@Component({
  selector: 'app-bandwidth-overview-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    MatExpansionModule,
    MatIconModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatDividerModule,
    TranslatePipe,
    FormatRateValuePipe,
  ],
  templateUrl: './bandwidth-overview-panel.component.html',
  styleUrls: ['./bandwidth-overview-panel.component.scss'],
})
export class BandwidthOverviewPanelComponent {
  readonly expanded = model<boolean>(false);
  readonly hideToggle = input<boolean>(false);

  private readonly rcloneStatusService = inject(RcloneStatusService);
  private readonly validatorRegistry = inject(ValidatorRegistryService);
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);

  readonly bandwidthLimit = this.rcloneStatusService.bandwidthLimit;
  readonly savedBandwidthLimit = this.rcloneStatusService.savedBandwidthLimit;
  readonly bandwidthPresets = BANDWIDTH_PRESETS;

  readonly isBandwidthLimited = computed(() => {
    const limit = this.bandwidthLimit();
    return !!limit && limit.rate !== 'off' && limit.rate !== '' && limit.bytesPerSecond > 0;
  });

  readonly bandwidthDetails = computed((): BandwidthDetailItem[] => {
    const limit = this.bandwidthLimit();
    return [
      { labelKey: 'generalOverview.bandwidth.upload', bytesPerSec: limit?.bytesPerSecondTx },
      { labelKey: 'generalOverview.bandwidth.download', bytesPerSec: limit?.bytesPerSecondRx },
      { labelKey: 'generalOverview.bandwidth.total', bytesPerSec: limit?.bytesPerSecond },
    ];
  });

  private readonly bandwidthValidator = this.validatorRegistry.getValidator('bandwidthFormat');
  readonly customBandwidthControl = new FormControl<string>('', {
    validators: this.bandwidthValidator ? [this.bandwidthValidator] : [],
    nonNullable: true,
  });

  private readonly customBandwidthValue = toSignal(this.customBandwidthControl.valueChanges, {
    initialValue: '',
  });
  private readonly customBandwidthStatus = toSignal(this.customBandwidthControl.statusChanges, {
    initialValue: 'VALID',
  });

  readonly isCustomBandwidthChanged = computed(() => {
    const saved = this.savedBandwidthLimit();
    const val = (this.customBandwidthValue() ?? '').trim();
    const status = this.customBandwidthStatus();
    return val.length > 0 && val !== saved && status === 'VALID';
  });

  constructor() {
    effect(() => {
      const saved = this.savedBandwidthLimit();
      this.customBandwidthControl.setValue(saved, { emitEvent: false });
    });
  }

  isPresetActive(presetValue: string): boolean {
    const current = this.savedBandwidthLimit();
    return presetValue === 'off' ? current === '' || current === 'off' : current === presetValue;
  }

  getBandwidthErrorMessage(): string {
    if (this.customBandwidthControl.hasError('bandwidth')) {
      return this.translate.instant('validators.bandwidth');
    }
    return '';
  }

  async setBandwidthLimit(rate: string): Promise<void> {
    try {
      await this.rcloneStatusService.setBandwidthLimit(rate);
      const persistedValue = rate === 'off' ? '' : rate;
      this.customBandwidthControl.setValue(persistedValue, { emitEvent: false });
    } catch (err: unknown) {
      console.error('[BandwidthOverviewPanel] Failed to set bandwidth limit:', err);
      const errorMessage =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : this.translate.instant('generalOverview.bandwidth.error');
      this.notificationService.showError(errorMessage);
    }
  }

  async applyCustomBandwidth(): Promise<void> {
    if (this.customBandwidthControl.invalid) {
      this.customBandwidthControl.markAsTouched();
      const errorMessage =
        this.getBandwidthErrorMessage() || this.translate.instant('validators.bandwidth');
      this.notificationService.showError(errorMessage);
      return;
    }

    const value = this.customBandwidthControl.value.trim();
    if (!value || value === this.savedBandwidthLimit()) return;
    await this.setBandwidthLimit(value);
  }

  loadBandwidthLimit(): Promise<void> {
    return this.rcloneStatusService.loadBandwidthLimit();
  }
}
