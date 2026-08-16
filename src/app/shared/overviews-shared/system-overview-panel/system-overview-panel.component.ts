import { ChangeDetectionStrategy, Component, computed, inject, input, model } from '@angular/core';
import { NgClass } from '@angular/common';
import { TranslatePipe } from '@ngx-translate/core';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';

import { FormatFileSizePipe, FormatTimePipe } from '@app/pipes';
import { RcloneStatusService } from 'src/app/services/infrastructure/maintenance/rclone-status.service';

@Component({
  selector: 'app-system-overview-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgClass,
    MatExpansionModule,
    MatIconModule,
    TranslatePipe,
    FormatFileSizePipe,
    FormatTimePipe,
  ],
  templateUrl: './system-overview-panel.component.html',
  styleUrls: ['./system-overview-panel.component.scss'],
})
export class SystemOverviewPanelComponent {
  readonly expanded = model<boolean>(false);
  readonly hideToggle = input<boolean>(false);

  readonly totalCount = input<number | undefined>(undefined);
  readonly totalCountLabelKey = input<string>('generalOverview.system.totalRemotes');
  readonly activeJobsCount = input<number | undefined>(undefined);

  private readonly rcloneStatusService = inject(RcloneStatusService);

  readonly rcloneStatus = this.rcloneStatusService.rcloneStatus;
  readonly rcloneInfo = this.rcloneStatusService.rcloneInfo;
  readonly rclonePID = this.rcloneStatusService.rclonePID;
  readonly isLoadingStats = this.rcloneStatusService.isLoading;
  readonly memoryUsage = this.rcloneStatusService.memoryUsage;
  readonly uptime = this.rcloneStatusService.uptime;

  readonly platformIcon = computed(() => {
    const os = (this.rcloneInfo()?.os || '').toLowerCase();
    if (os.includes('linux')) return 'linux';
    if (os.includes('darwin') || os.includes('mac') || os.includes('apple') || os.includes('ios')) {
      return 'apple';
    }
    if (os.includes('windows') || os.includes('win')) return 'windows';
    return 'desktop';
  });

  readonly platformDisplay = computed(() => {
    const info = this.rcloneInfo();
    if (!info?.os) return '-';
    const osName = info.os.charAt(0).toUpperCase() + info.os.slice(1);
    return info.arch ? `${osName} (${info.arch})` : osName;
  });
}
