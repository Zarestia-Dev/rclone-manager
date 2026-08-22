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
import { MatSnackBarModule, MatSnackBar } from '@angular/material/snack-bar';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';

import {
  JobInfo,
  Remote,
  Automation,
  ServeListItem,
  StartJobEvent,
  StopJobEvent,
  PanelConfig,
  DashboardPanel,
  SCROLL_DELAY_MS,
  ALL_PANELS,
  OpenInFilesEvent,
} from '@app/types';

import { RemotesPanelComponent } from '../../../../shared/overviews-shared/remotes-panel/remotes-panel.component';
import { OverviewHeaderComponent } from '../../../../shared/overviews-shared/overview-header/overview-header.component';
import { BandwidthOverviewPanelComponent } from '../../../../shared/overviews-shared/bandwidth-overview-panel/bandwidth-overview-panel.component';
import { SystemOverviewPanelComponent } from '../../../../shared/overviews-shared/system-overview-panel/system-overview-panel.component';
import { JobsOverviewPanelComponent } from '../../../../shared/overviews-shared/jobs-overview-panel/jobs-overview-panel.component';
import { ServesOverviewPanelComponent } from '../../../../shared/overviews-shared/serves-overview-panel/serves-overview-panel.component';
import { AutomationsOverviewPanelComponent } from '../../../../shared/overviews-shared/automations-overview-panel/automations-overview-panel.component';
import { AutomationService } from 'src/app/services/operations/automation.service';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { LocalStorageService } from 'src/app/services/ui/state/local-storage.service';
import { NavigationDispatcherService } from 'src/app/services/ui/navigation-dispatcher.service';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';

@Component({
  selector: 'app-general-overview',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatIconModule,
    MatButtonModule,
    MatSnackBarModule,
    MatSlideToggleModule,
    DragDropModule,
    RemotesPanelComponent,
    OverviewHeaderComponent,
    BandwidthOverviewPanelComponent,
    SystemOverviewPanelComponent,
    JobsOverviewPanelComponent,
    ServesOverviewPanelComponent,
    AutomationsOverviewPanelComponent,
    TranslatePipe,
  ],
  templateUrl: './general-overview.component.html',
  styleUrls: ['./general-overview.component.scss'],
})
export class GeneralOverviewComponent {
  private readonly snackBar = inject(MatSnackBar);
  private readonly automationService = inject(AutomationService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly translate = inject(TranslateService);
  private readonly localStorage = inject(LocalStorageService);
  private readonly navigationDispatcher = inject(NavigationDispatcherService);
  private readonly uiStateService = inject(UiStateService);

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
  readonly isEditingLayout = computed(() => this.uiStateService.isEditingOverview('general'));
  readonly cardDisplayMode = this.uiStateService.cardDisplayMode;
  readonly panelOpenStates = signal<Record<string, boolean>>(
    this.localStorage.get<Record<string, boolean>>('dashboard.panelOpenStates', {
      remotes: true,
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
  readonly displayPanels = computed(() =>
    this.isEditingLayout() ? this.dashboardPanels() : this.dashboardPanels().filter(p => p.visible)
  );

  // --- Computed Pipeline ---
  readonly totalRemotes = computed(() => this.remoteFacade.activeRemotes().length);
  readonly runningJobs = computed(() =>
    this.remoteFacade.jobs().filter(j => j.status === 'Running' && !j.parent_job_id)
  );
  readonly activeJobsCount = computed(() => this.runningJobs().length);

  constructor() {
    void this.loadLayoutSettings();
  }

  // --- Layout management ---
  toggleEditLayout(): void {
    this.uiStateService.toggleLayoutEdit({
      overviewId: 'general',
      hasViewToggle: true,
      onReset: () => this.resetLayout(),
    });
  }

  resetLayout(): void {
    void this.appSettingsService.saveSetting('runtime', 'dashboard_layout', {
      order: [],
      hidden: [],
    });
    void this.appSettingsService.saveSetting('runtime', 'dashboard_card_variant', 'compact');
    this.dashboardPanels.set(ALL_PANELS.map(p => ({ ...p, visible: p.defaultVisible })));
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
  }

  // --- Actions ---
  handleJobClick(job: JobInfo): void {
    this.navigationDispatcher.navigateToJob(job);
  }

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
    this.navigationDispatcher.navigateToServe(serve);
    setTimeout(() => this.scrollToTop(), SCROLL_DELAY_MS);
  }

  async toggleAutomation(automationId: string): Promise<void> {
    try {
      await this.automationService.toggleAutomation(automationId);
    } catch (error) {
      console.error('Failed to toggle automation:', error);
      this.showSnackbar(this.translate.instant('generalOverview.layout.toggleAutomationFailed'));
    }
  }

  onAutomationClick(automation: Automation): void {
    this.navigationDispatcher.navigateToAutomation(automation);
  }

  onOpenAutomationInFiles(path: string): void {
    const { remote: remoteName, path: relativePath } = this.pathService.splitFsPath(path);
    void this.remoteFacade.openRemoteInFiles(remoteName, relativePath);
  }

  // --- Private helpers ---
  private async loadLayoutSettings(): Promise<void> {
    try {
      const savedLayout = await this.appSettingsService.getSettingValue<
        { order: string[]; hidden: string[] } | string[]
      >('runtime.dashboard_layout');

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
