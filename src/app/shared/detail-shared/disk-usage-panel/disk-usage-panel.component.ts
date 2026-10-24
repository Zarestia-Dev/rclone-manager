import { Component, input, output, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { NgClass, NgStyle } from '@angular/common';
import { TranslatePipe } from '@ngx-translate/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { DiskUsage, DiskUsageSeverity } from '@app/types';
import { FormatFileSizePipe } from '@app/pipes';
import { BackendTranslationService } from 'src/app/services/i18n/backend-translation.service';

@Component({
  selector: 'app-disk-usage-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgClass,
    NgStyle,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    FormatFileSizePipe,
    TranslatePipe,
  ],
  styleUrls: ['./disk-usage-panel.component.scss'],
  templateUrl: './disk-usage-panel.component.html',
})
export class DiskUsagePanelComponent {
  private readonly backendTranslation = inject(BackendTranslationService);

  readonly config = input.required<DiskUsage>();
  readonly retry = output<void>();

  readonly usagePercentage = computed(() => {
    const cfg = this.config();
    if (cfg.total && cfg.total > 0 && cfg.used !== undefined) {
      return Math.min(100, Math.max(0, (cfg.used / cfg.total) * 100));
    }
    return 0;
  });
  readonly usagePercentageLabel = computed(() => `${Math.round(this.usagePercentage())}%`);
  readonly usageSeverity = computed<DiskUsageSeverity>(() => {
    const pct = this.usagePercentage();
    if (pct >= 90) return 'critical';
    if (pct >= 80) return 'high';
    if (pct >= 60) return 'warning';
    return 'healthy';
  });
  readonly formattedErrorMessage = computed(() => {
    const msg = this.config().errorMessage;
    return msg ? this.backendTranslation.translateBackendMessage(msg) : '';
  });
}
