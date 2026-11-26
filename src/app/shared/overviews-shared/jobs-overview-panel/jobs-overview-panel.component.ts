import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  model,
  signal,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import { JobStatItem, JOB_STATUS, matchesOriginFilter, PANEL_TONE } from '@app/types';
import {
  FormatEtaPipe,
  FormatFileSizePipe,
  FormatRateValuePipe,
  FormatNumberPipe,
} from '@app/pipes';
import { JobManagementService } from '../../../services/operations/job-management.service';
import { RcloneStatusService } from '../../../services/infrastructure/maintenance/rclone-status.service';
import { LocalStorageService } from '../../../services/ui/state/local-storage.service';
import { CopyToClipboardDirective } from '../../directives/copy-to-clipboard.directive';
import { AlertBannerComponent } from '../../components/alert-banner/alert-banner.component';
import { OriginFilterService } from '../../../services/ui/state/origin-filter.service';
import { OriginFilterBarComponent } from '../origin-filter-bar/origin-filter-bar.component';
import { JobsPanelComponent } from '../../detail-shared/jobs-panel/jobs-panel.component';

import { PillDirective } from '../../directives/pill.directive';

/** How many finished jobs the panel lists; the backend keeps many more. */
const RECENT_JOBS_SHOWN = 50;
const RECENT_OPEN_KEY = 'jobsOverview.recentOpen';

@Component({
  selector: 'app-jobs-overview-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormatNumberPipe,
    MatExpansionModule,
    MatIconModule,
    MatProgressBarModule,
    TranslatePipe,
    FormatEtaPipe,
    FormatFileSizePipe,
    FormatRateValuePipe,
    CopyToClipboardDirective,
    AlertBannerComponent,
    OriginFilterBarComponent,
    PillDirective,
    JobsPanelComponent,
  ],
  templateUrl: './jobs-overview-panel.component.html',
  styleUrls: ['./jobs-overview-panel.component.scss'],
})
export class JobsOverviewPanelComponent {
  /** The colour role of the panel's icon and count pill. */
  protected readonly tone = PANEL_TONE.jobs;
  readonly expanded = model<boolean>(false);

  readonly showFilterChips = input<boolean>(false);

  private readonly jobService = inject(JobManagementService);
  private readonly rcloneStatusService = inject(RcloneStatusService);
  private readonly localStorage = inject(LocalStorageService);

  protected readonly originFilters = inject(OriginFilterService);

  /** Chips off (the app overview): everything shows, whatever the panel was left on elsewhere. */
  readonly selectedOriginFilter = computed(() =>
    this.showFilterChips() ? this.originFilters.get('jobs') : 'all'
  );

  readonly jobStats = this.rcloneStatusService.jobStats;
  readonly isLoadingStats = this.rcloneStatusService.isLoading;

  private readonly allRunningJobs = computed(() =>
    this.jobService.jobs().filter(j => j.status === JOB_STATUS.Running && !j.parent_job_id)
  );

  readonly runningJobs = computed(() => {
    const filter = this.selectedOriginFilter();
    return this.allRunningJobs().filter(j => matchesOriginFilter(j, filter));
  });

  /** Every running job, whatever the chip: the header counts what runs, not what the chip shows. */
  readonly activeJobsCount = computed(() => this.allRunningJobs().length);

  /** Running jobs the origin chip hides. */
  readonly hiddenCount = computed(() => this.activeJobsCount() - this.runningJobs().length);

  /** The latest finished jobs of every remote and local disk, newest first like the job list. */
  readonly recentJobs = computed(() => {
    const filter = this.selectedOriginFilter();
    return this.jobService
      .jobs()
      .filter(
        j => j.status !== JOB_STATUS.Running && !j.parent_job_id && matchesOriginFilter(j, filter)
      )
      .slice(0, RECENT_JOBS_SHOWN);
  });

  /** Finished jobs stay folded away until the user opens them; the choice is remembered. */
  readonly recentOpen = signal(this.localStorage.get(RECENT_OPEN_KEY, false));

  setRecentOpen(open: boolean): void {
    this.recentOpen.set(open);
    this.localStorage.set(RECENT_OPEN_KEY, open);
  }

  readonly jobCompletionPercentage = computed(() => {
    const { totalBytes = 0, bytes = 0 } = this.jobStats();
    return totalBytes > 0 ? Math.min(100, (bytes / totalBytes) * 100) : 0;
  });

  readonly jobStatsItems = computed((): JobStatItem[] => {
    const s = this.jobStats();
    return [
      { labelKey: 'generalOverview.jobs.speed', value: s.speed, formatAsBytes: true },
      { labelKey: 'generalOverview.jobs.transfers', value: `${s.transfers} / ${s.totalTransfers}` },
      { labelKey: 'generalOverview.jobs.checks', value: `${s.checks} / ${s.totalChecks}` },
      { labelKey: 'generalOverview.jobs.errors', value: s.errors, error: s.errors > 0 },
      { labelKey: 'generalOverview.jobs.deletes', value: s.deletes },
      { labelKey: 'generalOverview.jobs.renames', value: s.renames },
      { labelKey: 'generalOverview.jobs.updatedDirs', value: s.updatedDirs ?? 0 },
      { labelKey: 'generalOverview.jobs.serverCopies', value: s.serverSideCopies },
      { labelKey: 'generalOverview.jobs.serverMoves', value: s.serverSideMoves },
    ];
  });

  async onDeleteJob(jobid: number): Promise<void> {
    try {
      await this.jobService.deleteJob(jobid);
    } catch (error) {
      console.error('Failed to delete job:', error);
    }
  }
}
