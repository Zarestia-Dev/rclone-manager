import { ChangeDetectionStrategy, Component, inject, computed, output } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBarModule, MatSnackBar } from '@angular/material/snack-bar';

import {
  Remote,
  Automation,
  ServeListItem,
  StartJobEvent,
  StopJobEvent,
  SCROLL_DELAY_MS,
  OpenInFilesEvent,
  profileOf,
  GENERAL_OVERVIEW_LAYOUT,
} from '@app/types';

import {
  OverviewPanelDirective,
  OverviewPanelsComponent,
} from '../../../../shared/overviews-shared/overview-panels/overview-panels.component';
import { RemotesPanelComponent } from '../../../../shared/overviews-shared/remotes-panel/remotes-panel.component';
import { OverviewHeaderComponent } from '../../../../shared/overviews-shared/overview-header/overview-header.component';
import { BandwidthOverviewPanelComponent } from '../../../../shared/overviews-shared/bandwidth-overview-panel/bandwidth-overview-panel.component';
import { SystemOverviewPanelComponent } from '../../../../shared/overviews-shared/system-overview-panel/system-overview-panel.component';
import { JobsOverviewPanelComponent } from '../../../../shared/overviews-shared/jobs-overview-panel/jobs-overview-panel.component';
import { MountsOverviewPanelComponent } from '../../../../shared/overviews-shared/mounts-overview-panel/mounts-overview-panel.component';
import { ServesOverviewPanelComponent } from '../../../../shared/overviews-shared/serves-overview-panel/serves-overview-panel.component';
import { AutomationsOverviewPanelComponent } from '../../../../shared/overviews-shared/automations-overview-panel/automations-overview-panel.component';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
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
    OverviewPanelsComponent,
    OverviewPanelDirective,
    RemotesPanelComponent,
    OverviewHeaderComponent,
    BandwidthOverviewPanelComponent,
    SystemOverviewPanelComponent,
    JobsOverviewPanelComponent,
    MountsOverviewPanelComponent,
    ServesOverviewPanelComponent,
    AutomationsOverviewPanelComponent,
    TranslatePipe,
  ],
  templateUrl: './general-overview.component.html',
  styleUrls: ['./general-overview.component.scss'],
})
export class GeneralOverviewComponent {
  private readonly snackBar = inject(MatSnackBar);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly translate = inject(TranslateService);
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
  readonly isEditingLayout = computed(() =>
    this.uiStateService.isEditingOverview(GENERAL_OVERVIEW_LAYOUT.id)
  );
  readonly cardDisplayMode = this.uiStateService.cardDisplayMode;
  readonly layout = GENERAL_OVERVIEW_LAYOUT;

  // --- Computed Pipeline ---
  readonly totalRemotes = computed(() => this.remoteFacade.activeRemotes().length);
  readonly runningJobs = computed(() =>
    this.remoteFacade.jobs().filter(j => j.status === 'Running' && !j.parent_job_id)
  );
  readonly activeJobsCount = computed(() => this.runningJobs().length);

  // --- Layout management ---
  /** The panel layout went back to its defaults: so do the cards and the remote order. */
  onLayoutReset(): void {
    void this.appSettingsService.saveSetting('runtime', 'dashboard_card_variant', 'compact');
    void this.remoteFacade.saveCurrentLayout(this.backendService.activeBackend(), []);
  }

  resetRemoteLayout(): void {
    void this.remoteFacade.saveCurrentLayout(this.backendService.activeBackend(), []);
    this.showSnackbar(this.translate.instant('generalOverview.layout.resetSuccess'));
  }

  // --- Actions ---
  stopServe(serve: ServeListItem): void {
    const remoteName = this.pathService.getRemoteNameFromFs(serve.params?.fs);
    if (remoteName)
      this.stopJob.emit({
        type: 'serve',
        remoteName,
        serveId: serve.id,
        profileName: profileOf(serve) || '',
      });
  }

  handleServeCardClick(serve: ServeListItem): void {
    this.navigationDispatcher.navigateToServe(serve);
    setTimeout(() => this.scrollToTop(), SCROLL_DELAY_MS);
  }

  onAutomationClick(automation: Automation): void {
    this.navigationDispatcher.navigateToAutomation(automation);
  }

  // --- Private helpers ---
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
