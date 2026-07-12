import { NgClass, DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
  computed,
  output,
} from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBarModule, MatSnackBar } from '@angular/material/snack-bar';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';

import {
  JobInfo,
  Remote,
  Automation,
  ServeListItem,
  CardDisplayMode,
  StartJobEvent,
  StopJobEvent,
  PanelConfig,
  DashboardPanel,
  SCROLL_DELAY_MS,
  JOB_ICON_MAP,
  ALL_PANELS,
  BandwidthDetailItem,
  JobStatItem,
  OpenInFilesEvent,
} from '@app/types';

import { FormatTimePipe, FormatEtaPipe, FormatFileSizePipe, FormatRateValuePipe } from '@app/pipes';
import { RemotesPanelComponent } from '../../../../shared/overviews-shared/remotes-panel/remotes-panel.component';
import { ServeCardComponent } from '../../../../shared/components/serve-card/serve-card.component';
import { OverviewHeaderComponent } from '../../../../shared/overviews-shared/overview-header/overview-header.component';
import { AutomationService } from 'src/app/services/operations/automation.service';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';
import { RcloneStatusService } from 'src/app/services/infrastructure/maintenance/rclone-status.service';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { LocalStorageService } from 'src/app/services/ui/state/local-storage.service';
import { CopyToClipboardDirective } from '../../../../shared/directives/copy-to-clipboard.directive';
import { AutomationCardComponent } from '../../../../shared/detail-shared/automation-card/automation-card.component';

interface RunningJobViewModel {
  job: JobInfo;
  typeIcon: string;
  label: string;
}

@Component({
  selector: 'app-general-overview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgClass,
    DecimalPipe,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatExpansionModule,
    MatProgressBarModule,
    MatTooltipModule,
    MatSnackBarModule,
    MatSlideToggleModule,
    DragDropModule,
    FormatTimePipe,
    FormatEtaPipe,
    FormatFileSizePipe,
    RemotesPanelComponent,
    ServeCardComponent,
    FormatRateValuePipe,
    OverviewHeaderComponent,
    TranslatePipe,
    CopyToClipboardDirective,
    AutomationCardComponent,
  ],
  templateUrl: './general-overview.component.html',
  styleUrls: ['./general-overview.component.scss'],
})
export class GeneralOverviewComponent {
  private readonly snackBar = inject(MatSnackBar);
  private readonly automationService = inject(AutomationService);
  private readonly uiStateService = inject(UiStateService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly rcloneStatusService = inject(RcloneStatusService);
  private readonly translate = inject(TranslateService);
  private readonly localStorage = inject(LocalStorageService);

  readonly iconService = inject(IconService);
  readonly backendService = inject(BackendService);
  readonly remoteFacade = inject(RemoteFacadeService);
  private readonly pathService = inject(PathService);

  // --- Outputs ---
  readonly selectRemote = output<Remote>();
  readonly startJob = output<StartJobEvent>();
  readonly stopJob = output<StopJobEvent>();
  readonly browseRemote = output<OpenInFilesEvent>();
  readonly openBackendModal = output<void>();

  // --- State ---
  readonly isEditingLayout = signal(false);
  readonly cardDisplayMode = signal<CardDisplayMode>('compact');
  readonly panelOpenStates = signal<Record<string, boolean>>(
    this.localStorage.get<Record<string, boolean>>('dashboard.panelOpenStates', {
      bandwidth: false,
      system: false,
      jobs: false,
      automations: false,
      serves: false,
    })
  );
  readonly dashboardPanels = signal<DashboardPanel[]>(
    ALL_PANELS.map(p => ({ ...p, visible: p.defaultVisible }))
  );

  readonly automations = this.automationService.automations;

  // --- Re-exposed Service Signals ---
  readonly rcloneStatus = this.rcloneStatusService.rcloneStatus;
  readonly jobStats = this.rcloneStatusService.jobStats;
  readonly bandwidthLimit = this.rcloneStatusService.bandwidthLimit;
  readonly isLoadingStats = this.rcloneStatusService.isLoading;
  readonly memoryUsage = this.rcloneStatusService.memoryUsage;
  readonly uptime = this.rcloneStatusService.uptime;

  // --- Computed Pipeline ---
  readonly totalRemotes = computed(() => this.remoteFacade.activeRemotes().length);
  readonly runningJobs = computed(() =>
    this.remoteFacade.jobs().filter(j => j.status === 'Running' && !j.parent_job_id)
  );
  readonly activeJobsCount = computed(() => this.runningJobs().length);
  readonly runningJobViewModels = computed<RunningJobViewModel[]>(() =>
    this.runningJobs().map(job => ({
      job,
      typeIcon: this.getJobTypeIcon(job),
      label: this.getJobLabel(job),
    }))
  );
  readonly allRunningServes = computed(() =>
    this.remoteFacade.activeRemotes().flatMap(r => r.status.serve?.serves ?? [])
  );

  readonly jobCompletionPercentage = computed(() => {
    const { totalBytes = 0, bytes = 0 } = this.jobStats();
    return totalBytes > 0 ? Math.min(100, (bytes / totalBytes) * 100) : 0;
  });

  readonly isBandwidthLimited = computed(() => {
    const limit = this.bandwidthLimit();
    return !!limit && limit.rate !== 'off' && limit.rate !== '' && limit.bytesPerSecond > 0;
  });

  readonly activeAutomationsCount = computed(
    () => this.automations().filter(t => t.status === 'enabled' || t.status === 'running').length
  );

  readonly totalAutomationsCount = computed(() => this.automations().length);

  readonly bandwidthDetails = computed((): BandwidthDetailItem[] => {
    const limit = this.bandwidthLimit();
    return [
      { labelKey: 'generalOverview.bandwidth.upload', bytesPerSec: limit?.bytesPerSecondTx },
      { labelKey: 'generalOverview.bandwidth.download', bytesPerSec: limit?.bytesPerSecondRx },
      { labelKey: 'generalOverview.bandwidth.total', bytesPerSec: limit?.bytesPerSecond },
    ];
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
      { labelKey: 'generalOverview.jobs.serverCopies', value: s.serverSideCopies },
      { labelKey: 'generalOverview.jobs.serverMoves', value: s.serverSideMoves },
    ];
  });

  constructor() {
    this.initDashboardData();
  }

  private async initDashboardData(): Promise<void> {
    await this.loadLayoutSettings();
  }

  // --- Layout management ---
  toggleEditLayout(): void {
    this.isEditingLayout.update(v => !v);
  }

  toggleCardDisplayMode(): void {
    this.cardDisplayMode.update(m => (m === 'compact' ? 'detailed' : 'compact'));
    this.persistLayout();
  }

  resetLayout(): void {
    void this.appSettingsService.saveSetting('runtime', 'dashboard_layout', {
      order: [],
      hidden: [],
    });
    void this.appSettingsService.saveSetting('runtime', 'dashboard_card_variant', 'compact');
    this.dashboardPanels.set(ALL_PANELS.map(p => ({ ...p, visible: p.defaultVisible })));
    this.cardDisplayMode.set('compact');
    void this.remoteFacade.saveCurrentLayout(this.backendService.activeBackend(), []);
    this.showSnackbar(this.translate.instant('generalOverview.layout.resetSuccess'));
  }

  resetRemoteLayout(): void {
    void this.remoteFacade.saveCurrentLayout(this.backendService.activeBackend(), []);
    this.showSnackbar(this.translate.instant('generalOverview.layout.resetSuccess'));
  }

  drop(event: CdkDragDrop<DashboardPanel[]>): void {
    this.dashboardPanels.update(panels => {
      const updated = [...panels];
      moveItemInArray(updated, event.previousIndex, event.currentIndex);
      return updated;
    });
    this.persistLayout();
  }

  togglePanelVisibility(panelId: string): void {
    this.dashboardPanels.update(panels =>
      panels.map(p => (p.id === panelId ? { ...p, visible: !p.visible } : p))
    );
    this.persistLayout();
  }

  loadBandwidthLimit(): Promise<void> {
    return this.rcloneStatusService.loadBandwidthLimit();
  }

  protected setPanelOpenState(id: string, isOpen: boolean): void {
    const updated = { ...this.panelOpenStates(), [id]: isOpen };
    this.panelOpenStates.set(updated);
    this.localStorage.set('dashboard.panelOpenStates', updated);
  }

  private persistLayout(): void {
    const order = this.dashboardPanels().map(p => p.id);
    const hidden = this.dashboardPanels()
      .filter(p => !p.visible)
      .map(p => p.id);
    void this.appSettingsService.saveSetting('runtime', 'dashboard_layout', { order, hidden });
    void this.appSettingsService.saveSetting(
      'runtime',
      'dashboard_card_variant',
      this.cardDisplayMode()
    );
  }

  // --- Serve actions ---
  stopServe(serve: ServeListItem): void {
    const remoteName = this.pathService.getRemoteNameFromFs(serve.params?.fs);
    if (remoteName)
      this.stopJob.emit({
        type: 'serve',
        remoteName,
        serveId: serve.id,
        profileName: serve.profile || '',
      });
  }

  handleServeCardClick(serve: ServeListItem): void {
    const remoteName = this.pathService.getRemoteNameFromFs(serve.params?.fs);
    if (!remoteName) return;
    const remote = this.remoteFacade.activeRemotes().find(r => r.name === remoteName);
    if (remote) {
      this.uiStateService.setTab('serve');
      this.uiStateService.setSelectedRemote(remote);
      setTimeout(() => this.scrollToTop(), SCROLL_DELAY_MS);
    }
  }

  // --- Automation actions ---
  async toggleAutomation(automationId: string): Promise<void> {
    try {
      await this.automationService.toggleAutomation(automationId);
    } catch (error) {
      console.error('Failed to toggle automation:', error);
      this.showSnackbar(this.translate.instant('generalOverview.layout.toggleAutomationFailed'));
    }
  }

  onAutomationClick(automation: Automation): void {
    const remoteName = automation.args.remoteName;
    if (remoteName) {
      const remote = this.remoteFacade.activeRemotes().find(r => r.name === remoteName);
      if (remote) this.selectRemote.emit(remote);
    }
  }

  onOpenAutomationInFiles(path: string): void {
    const { remote: remoteName, path: relativePath } = this.pathService.splitFsPath(path);
    void this.remoteFacade.openRemoteInFiles(remoteName, relativePath);
  }

  getJobTypeIcon(job: JobInfo): string {
    return JOB_ICON_MAP[job.job_type] ?? 'folder';
  }

  getJobLabel(job: JobInfo): string {
    const key = `fileBrowser.operations.types.${job.job_type}`;
    const translated = this.translate.instant(key);
    return translated === key ? job.job_type.replace(/_/g, ' ') : translated;
  }

  // --- Private helpers ---
  private async loadLayoutSettings(): Promise<void> {
    try {
      const [savedLayout, savedVariant] = await Promise.all([
        this.appSettingsService.getSettingValue<{ order: string[]; hidden: string[] } | string[]>(
          'runtime.dashboard_layout'
        ),
        this.appSettingsService.getSettingValue<CardDisplayMode>('runtime.dashboard_card_variant'),
      ]);

      if (savedLayout) {
        const order: string[] = Array.isArray(savedLayout)
          ? savedLayout
          : (savedLayout.order ?? []);
        const hiddenIds = new Set<string>(
          Array.isArray(savedLayout) ? [] : (savedLayout.hidden ?? [])
        );

        if (order.length > 0) {
          const ordered = order
            .map(id => ALL_PANELS.find(p => p.id === id))
            .filter((p): p is PanelConfig => !!p)
            .map(p => ({ ...p, visible: !hiddenIds.has(p.id) }));

          const seenIds = new Set(order);
          const appended = ALL_PANELS.filter(p => !seenIds.has(p.id)).map(p => ({
            ...p,
            visible: p.defaultVisible,
          }));

          this.dashboardPanels.set([...ordered, ...appended]);
        }
      }
      if (savedVariant) this.cardDisplayMode.set(savedVariant);
    } catch {
      console.debug('Failed to load layout settings, using defaults');
    }
  }

  private scrollToTop(): void {
    const el = document.querySelector('.main-content') as HTMLElement | null;
    const target = el ?? document.scrollingElement ?? document.documentElement;
    try {
      target.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      (target as HTMLElement).scrollTop = 0;
    }
  }

  private showSnackbar(message: string, duration = 2000): void {
    this.snackBar.open(message, this.translate.instant('common.close'), { duration });
  }
}
