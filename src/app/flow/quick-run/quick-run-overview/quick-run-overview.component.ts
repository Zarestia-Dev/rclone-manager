import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';

import {
  QuickRun,
  StopJobEvent,
  DashboardPanel,
  ALL_QUICK_RUN_PANELS,
  PanelConfig,
  JobInfo,
  ServeListItem,
  Automation,
} from '@app/types';

import { QuickRunService } from 'src/app/services/flow/quick-run.service';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { AutomationService } from 'src/app/services/operations/automation.service';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { LocalStorageService } from 'src/app/services/ui/state/local-storage.service';
import { NavigationDispatcherService } from 'src/app/services/ui/navigation-dispatcher.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { IconService } from 'src/app/services/ui/icon.service';

import { OverviewHeaderComponent } from 'src/app/shared/overviews-shared/overview-header/overview-header.component';
import { BandwidthOverviewPanelComponent } from 'src/app/shared/overviews-shared/bandwidth-overview-panel/bandwidth-overview-panel.component';
import { SystemOverviewPanelComponent } from 'src/app/shared/overviews-shared/system-overview-panel/system-overview-panel.component';
import { JobsOverviewPanelComponent } from 'src/app/shared/overviews-shared/jobs-overview-panel/jobs-overview-panel.component';
import { ServesOverviewPanelComponent } from 'src/app/shared/overviews-shared/serves-overview-panel/serves-overview-panel.component';
import { AutomationsOverviewPanelComponent } from 'src/app/shared/overviews-shared/automations-overview-panel/automations-overview-panel.component';
import { QuickRunCardComponent } from '../quick-run-card/quick-run-card.component';

/**
 * Enriched overview for the Quick Run workspace in Flow.
 */
@Component({
  selector: 'app-quick-run-overview',
  standalone: true,
  imports: [
    MatIconModule,
    MatButtonModule,
    MatExpansionModule,
    MatSlideToggleModule,
    MatSnackBarModule,
    DragDropModule,
    TranslatePipe,
    OverviewHeaderComponent,
    BandwidthOverviewPanelComponent,
    SystemOverviewPanelComponent,
    JobsOverviewPanelComponent,
    ServesOverviewPanelComponent,
    AutomationsOverviewPanelComponent,
    QuickRunCardComponent,
  ],
  templateUrl: './quick-run-overview.component.html',
  styleUrl: './quick-run-overview.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuickRunOverviewComponent {
  private readonly quickRunService = inject(QuickRunService);
  private readonly jobService = inject(JobManagementService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly localStorage = inject(LocalStorageService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly translate = inject(TranslateService);
  private readonly automationService = inject(AutomationService);
  private readonly navigationDispatcher = inject(NavigationDispatcherService);
  private readonly pathService = inject(PathService);
  readonly iconService = inject(IconService);

  readonly remoteFacade = inject(RemoteFacadeService);

  readonly openRemoteDetail = output<string>();
  readonly openBackendModal = output<void>();

  readonly quickRuns = this.quickRunService.quickRuns;
  readonly runningIds = this.quickRunService.runningIds;
  readonly isEditingLayout = signal(false);

  readonly selectedRemoteFilter = signal<string | null>(null);

  readonly remoteGroups = computed(() => {
    const runs = this.quickRuns();
    const countMap = new Map<string, number>();
    for (const qr of runs) {
      const name = qr.remoteName || 'local';
      countMap.set(name, (countMap.get(name) || 0) + 1);
    }

    const allRemotes = this.remoteFacade.orderedRemotes();
    const result = allRemotes.map(r => ({
      remoteName: r.name,
      count: countMap.get(r.name) || 0,
      icon: this.iconService.getIconName(r.type),
    }));

    for (const [name, count] of countMap.entries()) {
      if (!result.some(g => g.remoteName === name)) {
        result.push({
          remoteName: name,
          count,
          icon: 'cloud',
        });
      }
    }

    return result;
  });

  readonly filteredQuickRuns = computed(() => {
    const filter = this.selectedRemoteFilter();
    if (!filter) return this.quickRuns();
    return this.quickRuns().filter(qr => qr.remoteName === filter);
  });

  readonly panelOpenStates = signal<Record<string, boolean>>(
    this.localStorage.get<Record<string, boolean>>('flow.quickRun.panelOpenStates', {
      quickRuns: true,
      bandwidth: false,
      system: false,
      jobs: true,
      serves: false,
      automations: false,
    })
  );

  readonly dashboardPanels = signal<DashboardPanel[]>(
    ALL_QUICK_RUN_PANELS.map(p => ({ ...p, visible: p.defaultVisible }))
  );

  readonly displayPanels = computed(() =>
    this.isEditingLayout() ? this.dashboardPanels() : this.dashboardPanels().filter(p => p.visible)
  );

  readonly totalCount = computed(() => this.quickRuns().length);
  readonly activeCount = computed(() => {
    const runningQrCount = this.runningIds().size;
    const activeJobsCount = this.jobService.activeJobs().length;
    return Math.max(runningQrCount, activeJobsCount);
  });

  constructor() {
    void this.loadLayoutSettings();
  }

  setRemoteFilter(remoteName: string | null): void {
    this.selectedRemoteFilter.set(remoteName);
  }

  onOpenRemoteDetail(remoteName: string): void {
    this.openRemoteDetail.emit(remoteName);
  }

  onCreateQuickRunForRemote(remoteName: string): void {
    this.quickRunService.openEditor(undefined, undefined, remoteName);
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

  isRunning(id: string): boolean {
    return this.runningIds().has(id);
  }

  // --- Layout management ---
  toggleEditLayout(): void {
    this.isEditingLayout.update(v => !v);
  }

  resetLayout(): void {
    void this.appSettingsService.saveSetting('runtime', 'quick_run_layout', {
      order: [],
      hidden: [],
    });
    this.dashboardPanels.set(ALL_QUICK_RUN_PANELS.map(p => ({ ...p, visible: p.defaultVisible })));
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

  protected setPanelOpenState(id: string, isOpen: boolean): void {
    const updated = { ...this.panelOpenStates(), [id]: isOpen };
    this.panelOpenStates.set(updated);
    this.localStorage.set('flow.quickRun.panelOpenStates', updated);
  }

  private persistLayout(): void {
    const order = this.dashboardPanels().map(p => p.id);
    const hidden = this.dashboardPanels()
      .filter(p => !p.visible)
      .map(p => p.id);
    void this.appSettingsService.saveSetting('runtime', 'quick_run_layout', { order, hidden });
  }

  // --- Smart Item Navigation Handlers ---
  handleJobClick(job: JobInfo): void {
    this.navigationDispatcher.navigateToJob(job);
  }

  async handleStopJob(event: StopJobEvent): Promise<void> {
    const activeJobs = this.jobService.activeJobs();
    const target = activeJobs.find(
      j => j.remote_name === event.remoteName && j.job_type === event.type
    );
    if (target) {
      await this.jobService.stopJob(target.jobid, event.remoteName);
    }
  }

  handleServeClick(serve: ServeListItem): void {
    this.navigationDispatcher.navigateToServe(serve);
  }

  handleStopServe(serve: ServeListItem): void {
    const remoteName = this.pathService.getRemoteNameFromFs(serve.params?.fs);
    if (remoteName) {
      void this.remoteFacade.stopJob(remoteName, 'serve', serve.id, serve.profile);
    }
  }

  handleAutomationClick(automation: Automation): void {
    const remoteName =
      automation.remoteName ||
      automation.args?.remoteName ||
      this.quickRuns().find(
        q => q.id === automation.profileName || q.name === automation.profileName
      )?.remoteName;

    if (remoteName) {
      this.openRemoteDetail.emit(remoteName);
    }
  }

  async toggleAutomation(automationId: string): Promise<void> {
    try {
      await this.automationService.toggleAutomation(automationId);
    } catch (error) {
      console.error('Failed to toggle automation:', error);
      this.showSnackbar(this.translate.instant('generalOverview.layout.toggleAutomationFailed'));
    }
  }

  openInFiles(path: string): void {
    const { remote: remoteName, path: relativePath } = this.pathService.splitFsPath(path);
    void this.remoteFacade.openRemoteInFiles(remoteName, relativePath);
  }

  private async loadLayoutSettings(): Promise<void> {
    try {
      const savedLayout = await this.appSettingsService.getSettingValue<
        | {
            order: string[];
            hidden: string[];
          }
        | string[]
      >('runtime.quick_run_layout');

      if (savedLayout) {
        const order: string[] = Array.isArray(savedLayout)
          ? savedLayout
          : (savedLayout.order ?? []);
        const hiddenIds = new Set<string>(
          Array.isArray(savedLayout) ? [] : (savedLayout.hidden ?? [])
        );

        if (order.length > 0) {
          const ordered = order
            .map(id => ALL_QUICK_RUN_PANELS.find(p => p.id === id))
            .filter((p): p is PanelConfig => !!p)
            .map(p => ({ ...p, visible: !hiddenIds.has(p.id) }));

          const seenIds = new Set(order);
          const appended = ALL_QUICK_RUN_PANELS.filter(p => !seenIds.has(p.id)).map(p => ({
            ...p,
            visible: p.defaultVisible,
          }));

          this.dashboardPanels.set([...ordered, ...appended]);
        }
      }
    } catch {
      console.debug('Failed to load Quick Run layout settings, using defaults');
    }
  }

  private showSnackbar(message: string, duration = 2000): void {
    this.snackBar.open(message, this.translate.instant('common.close'), { duration });
  }
}
