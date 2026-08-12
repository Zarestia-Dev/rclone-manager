import {
  Component,
  ChangeDetectionStrategy,
  signal,
  computed,
  inject,
  DestroyRef,
  afterNextRender,
} from '@angular/core';
import { MatSidenavModule, MatDrawerMode } from '@angular/material/sidenav';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { CdkMenuModule } from '@angular/cdk/menu';
import { TranslatePipe } from '@ngx-translate/core';

import { MountedRemote, QuickRun, ServeListItem, TabItem } from '@app/types';
import { FlowOverlayService } from 'src/app/services/ui/flow-overlay.service';
import { isMobile } from 'src/app/services/infrastructure/platform/api-client.service';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';
import { LocalStorageService } from 'src/app/services/ui/state/local-storage.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';

import { WindowControlsComponent } from 'src/app/shared/components/window-controls/window-controls.component';
import { AppMenuComponent } from 'src/app/shared/components/app-menu/app-menu.component';
import { SearchContainerComponent } from 'src/app/shared/components/search-container/search-container.component';
import { TabsButtonsComponent } from 'src/app/layout/tabs-buttons/tabs-buttons.component';
import { QuickRunCardComponent } from './quick-run/quick-run-card/quick-run-card.component';
import { QuickRunWorkspaceComponent } from './quick-run/quick-run-workspace/quick-run-workspace.component';

export type FlowSubMode = 'builder' | 'quick_run';

@Component({
  selector: 'app-flow-container',
  imports: [
    MatSidenavModule,
    MatIconModule,
    MatButtonModule,
    MatProgressBarModule,
    CdkMenuModule,
    TranslatePipe,
    WindowControlsComponent,
    AppMenuComponent,
    SearchContainerComponent,
    TabsButtonsComponent,
    QuickRunCardComponent,
    QuickRunWorkspaceComponent,
  ],
  templateUrl: './flow-container.component.html',
  styleUrl: './flow-container.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FlowContainerComponent {
  readonly flowOverlayService = inject(FlowOverlayService);
  readonly quickRunService = inject(QuickRunService);
  private readonly uiStateService = inject(UiStateService);
  private readonly remoteFacade = inject(RemoteFacadeService);
  private readonly pathService = inject(PathService);
  private readonly localStorage = inject(LocalStorageService);
  private readonly destroyRef = inject(DestroyRef);
  readonly isMobile = isMobile;

  /**
   * Currently-active Flow sub-mode. Defaults to `'quick_run'`. The Builder
   * tab switches to `'builder'` which shows a "working on it" placeholder.
   */
  readonly activeSubMode = signal<FlowSubMode>('quick_run');

  /** Tab definitions for flow container using TabsButtonsComponent. */
  readonly tabs: TabItem<FlowSubMode>[] = [
    { id: 'quick_run', icon: 'quick-run', label: 'flow.tabs.quickRun' },
    { id: 'builder', icon: 'workflow', label: 'flow.tabs.workflow' },
  ];

  // ── Sidenav & Sidebar state ───────────────────────────────────────────────

  readonly isSidebarOpen = signal(this.localStorage.get('ui.flowSidebarOpen', true));
  readonly sidebarMode = signal<MatDrawerMode>('side');
  readonly isSidebarOver = computed(() => this.sidebarMode() === 'over');
  readonly searchQuery = signal('');
  readonly searchVisible = signal(false);

  readonly quickRuns = this.quickRunService.quickRuns;
  readonly runningQuickRuns = this.quickRunService.runningQuickRuns;
  readonly idleQuickRuns = this.quickRunService.idleQuickRuns;
  readonly selectedId = this.quickRunService.selectedId;
  readonly isLoading = this.quickRunService.isLoading;
  readonly runningIds = this.quickRunService.runningIds;
  readonly mountedRemotes = this.remoteFacade.mountedRemotes;
  readonly runningServes = this.remoteFacade.runningServes;

  constructor() {
    afterNextRender(() => this.setupResponsiveLayout());

    this.uiStateService.registerMobileSidebar({
      view: 'flow',
      isOver: this.isSidebarOver,
      isOpen: this.isSidebarOpen,
    });

    this.destroyRef.onDestroy(() => {
      this.uiStateService.unregisterMobileSidebar('flow');
    });
  }

  setSidebarOpen(open: boolean): void {
    this.isSidebarOpen.set(open);
    this.localStorage.set('ui.flowSidebarOpen', open);
  }

  private setupResponsiveLayout(): void {
    const mql = window.matchMedia('(min-width: 900px)');
    const update = (matches: boolean): void => this.sidebarMode.set(matches ? 'side' : 'over');
    const handler = (e: MediaQueryListEvent): void => update(e.matches);

    update(mql.matches);
    mql.addEventListener('change', handler);
    this.destroyRef.onDestroy(() => mql.removeEventListener('change', handler));
  }

  /** Filtered running list — applies the search box. */
  readonly filteredRunning = computed(() => {
    const query = this.searchQuery().toLowerCase().trim();
    if (!query) return this.runningQuickRuns();
    return this.runningQuickRuns().filter(qr => this.matchesQuery(qr, query));
  });

  /** Filtered idle list — applies the search box. */
  readonly filteredIdle = computed(() => {
    const query = this.searchQuery().toLowerCase().trim();
    if (!query) return this.idleQuickRuns();
    return this.idleQuickRuns().filter(qr => this.matchesQuery(qr, query));
  });

  readonly hasAny = computed(() => this.quickRuns().length > 0);
  readonly hasRunning = computed(() => this.filteredRunning().length > 0);
  readonly hasIdle = computed(() => this.filteredIdle().length > 0);

  setSubMode(mode: FlowSubMode | string): void {
    this.activeSubMode.set(mode as FlowSubMode);
  }

  /** Open the quick-run editor in "create" mode. */
  newQuickRun(): void {
    this.setSubMode('quick_run');
    this.quickRunService.openEditor();
    if (this.sidebarMode() === 'over') {
      this.setSidebarOpen(false);
    }
  }

  /**
   * Switch to the Workflow Builder tab. The builder is not implemented yet —
   * clicking this shows the "working on it" placeholder.
   */
  newWorkflow(): void {
    this.setSubMode('builder');
  }

  selectQuickRun(id: string): void {
    this.quickRunService.select(id);
    this.setSubMode('quick_run');
    if (this.sidebarMode() === 'over') {
      this.setSidebarOpen(false);
    }
  }

  toggleSidebar(): void {
    this.setSidebarOpen(!this.isSidebarOpen());
  }

  toggleSearch(): void {
    this.searchVisible.update(v => !v);
  }

  async startQuickRun(id: string): Promise<void> {
    await this.quickRunService.start(id);
  }

  async stopQuickRun(id: string): Promise<void> {
    const qr = this.quickRuns().find(q => q.id === id);
    if (!qr) return;

    if (qr.operationType === 'mount') {
      const mountPoint = (qr.config?.rclone as Record<string, any> | undefined)?.['mountPoint'];
      const mounted = this.mountedRemotes().find(
        (m: MountedRemote) =>
          this.pathService.getRemoteNameFromFs(m.fs) === qr.remoteName ||
          (m.mount_point && m.mount_point === mountPoint)
      );
      if (mounted) {
        await this.remoteFacade.stopJob(
          qr.remoteName,
          'mount',
          undefined,
          mounted.profile ?? qr.name
        );
      } else {
        await this.quickRunService.stop(id);
      }
    } else if (qr.operationType === 'serve') {
      const serve = this.runningServes().find(
        (s: ServeListItem) => this.pathService.getRemoteNameFromFs(s.params?.fs) === qr.remoteName
      );
      if (serve) {
        await this.remoteFacade.stopJob(qr.remoteName, 'serve', serve.id, serve.profile);
      } else {
        await this.quickRunService.stop(id);
      }
    } else {
      await this.quickRunService.stop(id);
    }
  }

  editQuickRun(id: string): void {
    const qr = this.quickRuns().find(q => q.id === id);
    if (qr) {
      this.quickRunService.openEditor(qr);
      this.setSubMode('quick_run');
      if (this.sidebarMode() === 'over') {
        this.setSidebarOpen(false);
      }
    }
  }

  async duplicateQuickRun(id: string): Promise<void> {
    await this.quickRunService.duplicate(id);
  }

  async removeQuickRun(id: string): Promise<void> {
    await this.quickRunService.remove(id);
  }

  isRunning(id: string): boolean {
    const qr = this.quickRuns().find(q => q.id === id);
    if (!qr) return this.runningIds().has(id);

    if (qr.operationType === 'mount') {
      const mountPoint = (qr.config?.rclone as Record<string, any> | undefined)?.['mountPoint'];
      return this.mountedRemotes().some(
        (m: MountedRemote) =>
          m.profile === qr.name ||
          (this.pathService.getRemoteNameFromFs(m.fs) === qr.remoteName &&
            !!m.mount_point &&
            m.mount_point === mountPoint)
      );
    }
    if (qr.operationType === 'serve') {
      return this.runningServes().some(
        (s: ServeListItem) =>
          s.profile === qr.name ||
          this.pathService.getRemoteNameFromFs(s.params?.fs) === qr.remoteName
      );
    }
    return this.runningIds().has(id) || qr.status === 'running';
  }

  trackById(_index: number, qr: QuickRun): string {
    return qr.id;
  }

  detachOverlay(): void {
    void this.flowOverlayService.detachToStandaloneWindow();
  }

  closeOverlay(): void {
    this.flowOverlayService.closeFlowOverlay();
  }

  private matchesQuery(qr: QuickRun, query: string): boolean {
    const rclone = (qr.config.rclone ?? {}) as Record<string, unknown>;
    const opType = qr.operationType;
    const opData = (rclone[opType] as Record<string, unknown> | undefined) ?? rclone;
    const haystack = [
      qr.name,
      qr.description ?? '',
      qr.remoteName,
      qr.operationType,
      opData['srcFs'] ? String(opData['srcFs']) : rclone['srcFs'] ? String(rclone['srcFs']) : '',
      opData['dstFs'] ?? rclone['dstFs'] ?? '',
      opData['path1'] ?? rclone['path1'] ?? '',
      opData['path2'] ?? rclone['path2'] ?? '',
      opData['mountPoint'] ?? rclone['mountPoint'] ?? '',
      opData['fs'] ?? rclone['fs'] ?? '',
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  }
}
