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
import { TranslatePipe } from '@ngx-translate/core';

import {
  QuickRun,
  ServeListItem,
  Automation,
  OpenInFilesEvent,
  profileOf,
  QUICK_RUN_OVERVIEW_LAYOUT,
} from '@app/types';

import { QuickRunService } from 'src/app/services/flow/quick-run.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { NavigationDispatcherService } from 'src/app/services/ui/navigation-dispatcher.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { IconService } from 'src/app/services/ui/icon.service';

import {
  OverviewPanelDirective,
  OverviewPanelsComponent,
} from 'src/app/shared/overviews-shared/overview-panels/overview-panels.component';
import { OverviewHeaderComponent } from 'src/app/shared/overviews-shared/overview-header/overview-header.component';
import { BandwidthOverviewPanelComponent } from 'src/app/shared/overviews-shared/bandwidth-overview-panel/bandwidth-overview-panel.component';
import { SystemOverviewPanelComponent } from 'src/app/shared/overviews-shared/system-overview-panel/system-overview-panel.component';
import { JobsOverviewPanelComponent } from 'src/app/shared/overviews-shared/jobs-overview-panel/jobs-overview-panel.component';
import { MountsOverviewPanelComponent } from 'src/app/shared/overviews-shared/mounts-overview-panel/mounts-overview-panel.component';
import { ServesOverviewPanelComponent } from 'src/app/shared/overviews-shared/serves-overview-panel/serves-overview-panel.component';
import { AutomationsOverviewPanelComponent } from 'src/app/shared/overviews-shared/automations-overview-panel/automations-overview-panel.component';
import { QuickRunCardComponent } from '../quick-run-card/quick-run-card.component';

import { PillDirective } from '../../../shared/directives/pill.directive';
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
    OverviewPanelsComponent,
    OverviewPanelDirective,
    TranslatePipe,
    OverviewHeaderComponent,
    BandwidthOverviewPanelComponent,
    SystemOverviewPanelComponent,
    JobsOverviewPanelComponent,
    MountsOverviewPanelComponent,
    ServesOverviewPanelComponent,
    AutomationsOverviewPanelComponent,
    QuickRunCardComponent,
    PillDirective,
  ],
  templateUrl: './quick-run-overview.component.html',
  styleUrl: './quick-run-overview.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuickRunOverviewComponent {
  private readonly quickRunService = inject(QuickRunService);
  private readonly navigationDispatcher = inject(NavigationDispatcherService);
  private readonly pathService = inject(PathService);
  readonly iconService = inject(IconService);

  readonly remoteFacade = inject(RemoteFacadeService);

  readonly openRemoteDetail = output<string>();
  readonly openBackendModal = output<void>();

  readonly layout = QUICK_RUN_OVERVIEW_LAYOUT;

  readonly quickRuns = this.quickRunService.quickRuns;
  readonly runningIds = this.quickRunService.runningIds;

  readonly selectedRemoteFilter = signal<string | null>(null);

  readonly remoteGroups = computed(() => {
    const runs = this.quickRuns();
    const countMap = new Map<string, number>();
    for (const qr of runs) {
      const name = qr.remoteName || 'local';
      countMap.set(name, (countMap.get(name) || 0) + 1);
    }

    const allRemotes = this.remoteFacade.remoteSummaries();
    const result: { remoteName: string; count: number; icon: string; isMissing?: boolean }[] = [];

    for (const r of allRemotes) {
      const count = countMap.get(r.name) ?? 0;
      result.push({
        remoteName: r.name,
        count,
        icon: this.iconService.getIconName(r.type),
      });
      countMap.delete(r.name);
    }

    for (const [name, count] of countMap.entries()) {
      const isMissing = name !== 'local' && this.remoteFacade.isRemoteMissing(name);
      result.push({
        remoteName: name,
        count,
        icon: isMissing ? 'warning' : name === 'local' ? 'hard-drive' : 'cloud',
        ...(isMissing ? { isMissing: true } : {}),
      });
    }

    return result;
  });

  readonly filteredQuickRuns = computed(() => {
    const filter = this.selectedRemoteFilter();
    if (!filter) return this.quickRuns();
    return this.quickRuns().filter(qr => (qr.remoteName || 'local') === filter);
  });

  readonly totalCount = computed(() => this.quickRuns().length);
  readonly activeCount = computed(() => this.runningIds().size);

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

  onStartQuickRun(qr: QuickRun): void {
    void this.quickRunService.start(qr.id);
  }

  onStopQuickRun(qr: QuickRun): void {
    void this.quickRunService.stop(qr.id);
  }

  onEditQuickRun(qr: QuickRun): void {
    this.quickRunService.openEditor(qr);
  }

  // --- Smart Item Navigation Handlers ---
  handleServeClick(serve: ServeListItem): void {
    this.navigationDispatcher.navigateToServe(serve);
  }

  handleStopServe(serve: ServeListItem): void {
    const remoteName = this.pathService.getRemoteNameFromFs(serve.params?.fs);
    if (remoteName) {
      void this.remoteFacade.stopJob(remoteName, 'serve', serve.id, profileOf(serve));
    }
  }

  handleAutomationClick(automation: Automation): void {
    // A workflow or a Quick Run owns its automation and opens it; a profile's belongs to its remote.
    const source = automation.args?.source;
    if (source === 'workflow' || source === 'quickrun') {
      this.navigationDispatcher.navigateToAutomation(automation);
    } else if (automation.remoteName) {
      this.openRemoteDetail.emit(automation.remoteName);
    }
  }

  openInFiles(event: OpenInFilesEvent | string): void {
    if (typeof event === 'string') {
      const { remote: remoteName, path: relativePath } = this.pathService.splitFsPath(event);
      void this.remoteFacade.openRemoteInFiles(remoteName, relativePath);
    } else {
      void this.remoteFacade.openRemoteInFiles(
        event.remoteName,
        event.path,
        event.profileName,
        event.operationType
      );
    }
  }
}
