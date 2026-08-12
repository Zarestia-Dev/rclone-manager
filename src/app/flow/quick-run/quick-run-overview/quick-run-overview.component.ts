import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { TitleCasePipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';

import { QuickRun, JobsPanelConfig, StopJobEvent } from '@app/types';
import { FormatFileSizePipe, FormatRateValuePipe, FormatTimePipe } from '@app/pipes';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { RcloneStatusService } from 'src/app/services/infrastructure/maintenance/rclone-status.service';
import { SystemInfoService } from 'src/app/services/infrastructure/system/system-info.service';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { ModalService } from 'src/app/services/ui/modal.service';
import { OverviewHeaderComponent } from 'src/app/shared/overviews-shared/overview-header/overview-header.component';
import { JobsPanelComponent } from 'src/app/shared/detail-shared/jobs-panel/jobs-panel.component';
import { QuickRunCardComponent } from '../quick-run-card/quick-run-card.component';

/**
 * Main dashboard overview displayed in the Quick Run workspace when no item is selected.
 */
@Component({
  selector: 'app-quick-run-overview',
  imports: [
    TitleCasePipe,
    MatIconModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    TranslatePipe,
    FormatFileSizePipe,
    FormatRateValuePipe,
    FormatTimePipe,
    OverviewHeaderComponent,
    JobsPanelComponent,
    QuickRunCardComponent,
  ],
  templateUrl: './quick-run-overview.component.html',
  styleUrl: './quick-run-overview.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuickRunOverviewComponent {
  private readonly quickRunService = inject(QuickRunService);
  private readonly jobService = inject(JobManagementService);
  private readonly statusService = inject(RcloneStatusService);
  private readonly systemInfoService = inject(SystemInfoService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly modalService = inject(ModalService);

  readonly quickRuns = this.quickRunService.quickRuns;
  readonly runningIds = this.quickRunService.runningIds;
  readonly jobs = this.jobService.jobs;

  // System & Engine signals
  readonly rcloneStatus = this.statusService.rcloneStatus;
  readonly rcloneInfo = this.statusService.rcloneInfo;
  readonly bandwidthLimit = this.statusService.bandwidthLimit;
  readonly jobStats = this.statusService.jobStats;
  readonly memoryUsage = this.statusService.memoryUsage;
  readonly uptime = this.statusService.uptime;

  // App settings bandwidth limit key
  readonly savedBandwidthLimit = computed(() => {
    const opts = this.appSettingsService.options();
    return ((opts?.['core.bandwidth_limit']?.value as string) ?? '').trim();
  });

  readonly customBandwidthInput = signal<string>('');

  readonly isCustomBandwidthChanged = computed(() => {
    const saved = this.savedBandwidthLimit();
    const inputVal = this.customBandwidthInput().trim();
    return inputVal.length > 0 && inputVal !== saved;
  });

  constructor() {
    this.appSettingsService.loadSettings();

    effect(() => {
      const saved = this.savedBandwidthLimit();
      this.customBandwidthInput.set(saved);
    });
  }

  readonly jobsPanelConfig = computed<JobsPanelConfig>(() => ({
    jobs: this.jobs(),
  }));

  readonly totalCount = computed(() => this.quickRuns().length);
  readonly activeCount = computed(() => {
    const runningQrCount = this.runningIds().size;
    const activeJobsCount = this.jobService.activeJobs().length;
    return Math.max(runningQrCount, activeJobsCount);
  });
  readonly completedCount = computed(
    () => this.quickRuns().filter(qr => qr.status === 'completed').length
  );
  readonly failedCount = computed(
    () => this.quickRuns().filter(qr => qr.status === 'failed').length
  );

  openBackendModal(): void {
    this.modalService.openBackend();
  }

  onCreateQuickRun(): void {
    this.quickRunService.openEditor();
  }

  onSelectQuickRunById(id: string): void {
    this.quickRunService.select(id);
  }

  async onStartQuickRun(qr: QuickRun): Promise<void> {
    await this.quickRunService.start(qr.id);
  }

  async onStopQuickRun(qr: QuickRun): Promise<void> {
    await this.quickRunService.stop(qr.id);
  }

  onEditQuickRun(qr: QuickRun): void {
    this.quickRunService.openEditor(qr);
  }

  async setBandwidthLimit(rate: string): Promise<void> {
    try {
      await this.systemInfoService.bandwidthLimit(rate);
      await this.statusService.loadBandwidthLimit();
      const persistedValue = rate === 'off' ? '' : rate;
      this.customBandwidthInput.set(persistedValue);
      await this.appSettingsService.saveSetting('core', 'bandwidth_limit', persistedValue);
    } catch (err) {
      console.error('[QuickRunOverview] Failed to set bandwidth limit:', err);
    }
  }

  async applyCustomBandwidth(): Promise<void> {
    const value = this.customBandwidthInput().trim();
    if (!value || !this.isCustomBandwidthChanged()) return;
    await this.setBandwidthLimit(value);
  }

  async onStopJob(event: StopJobEvent): Promise<void> {
    const activeJobs = this.jobService.activeJobs();
    const target = activeJobs.find(
      j => j.remote_name === event.remoteName && j.job_type === event.type
    );
    if (target) {
      await this.jobService.stopJob(target.jobid, event.remoteName);
    }
  }

  async onDeleteJob(jobid: number): Promise<void> {
    await this.jobService.deleteJob(jobid);
  }

  isRunning(id: string): boolean {
    return this.runningIds().has(id);
  }
}
