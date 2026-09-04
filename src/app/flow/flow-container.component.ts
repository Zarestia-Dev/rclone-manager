import {
  Component,
  ChangeDetectionStrategy,
  signal,
  computed,
  inject,
  DestroyRef,
  afterNextRender,
  effect,
} from '@angular/core';
import { MatSidenavModule, MatDrawerMode } from '@angular/material/sidenav';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { CdkMenuModule } from '@angular/cdk/menu';
import { TranslatePipe } from '@ngx-translate/core';

import { TabItem, FlowSubMode } from '@app/types';
import { ModalService } from 'src/app/services/ui/modal.service';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';
import { LocalStorageService } from 'src/app/services/ui/state/local-storage.service';

import { TitlebarComponent } from 'src/app/layout/titlebar/titlebar.component';
import { SidebarComponent } from 'src/app/layout/sidebar/sidebar.component';
import { TabsButtonsComponent } from 'src/app/layout/tabs-buttons/tabs-buttons.component';
import { QuickRunWorkspaceComponent } from './quick-run/quick-run-workspace/quick-run-workspace.component';
import { WorkflowWorkspaceComponent } from './workflow/components/workflow-workspace/workflow-workspace.component';
import { WorkflowStateService } from '../services/flow/workflow-state.service';
import { BannerComponent } from '../layout/banners/banner.component';

@Component({
  selector: 'app-flow-container',
  imports: [
    MatSidenavModule,
    MatIconModule,
    MatButtonModule,
    CdkMenuModule,
    TranslatePipe,
    TitlebarComponent,
    SidebarComponent,
    TabsButtonsComponent,
    QuickRunWorkspaceComponent,
    WorkflowWorkspaceComponent,
    BannerComponent,
  ],
  templateUrl: './flow-container.component.html',
  styleUrl: './flow-container.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FlowContainerComponent {
  readonly quickRunService = inject(QuickRunService);
  private readonly workflowState = inject(WorkflowStateService);
  private readonly uiStateService = inject(UiStateService);
  private readonly localStorage = inject(LocalStorageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly modalService = inject(ModalService);

  private getInitialSubMode(): FlowSubMode {
    const stored = this.localStorage.get<string>('ui.flowActiveSubMode', 'quick_run');
    return stored === 'builder' ? 'builder' : 'quick_run';
  }

  /**
   * Currently-active Flow sub-mode. Initialized from localStorage if available,
   * falling back to `'quick_run'`.
   */
  readonly activeSubMode = signal<FlowSubMode>(this.getInitialSubMode());

  /** Tab definitions for flow container using TabsButtonsComponent. */
  readonly tabs: TabItem<FlowSubMode>[] = [
    { id: 'quick_run', icon: 'quick-run', label: 'flow.tabs.quickRun' },
    { id: 'builder', icon: 'workflow', label: 'flow.tabs.workflow' },
  ];

  // ── Sidenav state ─────────────────────────────────────────────────────────

  readonly isSidebarOpen = signal(this.localStorage.get('ui.flowSidebarOpen', true));
  readonly sidebarMode = signal<MatDrawerMode>('side');
  readonly isSidebarOver = computed(() => this.sidebarMode() === 'over');
  readonly hasDetailOpen = computed(
    () => !!this.quickRunService.selected() || !!this.uiStateService.selectedRemote()
  );

  goHome(): void {
    this.quickRunService.deselect();
    this.uiStateService.resetSelectedRemote();
  }

  constructor() {
    afterNextRender(() => this.setupResponsiveLayout());

    effect(() => {
      const mode = this.workflowState.requestedSubMode();
      if (mode) {
        this.setSubMode(mode);
        this.workflowState.requestedSubMode.set(null);
      }
    });

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

  private closeSidebarIfOver(): void {
    if (this.sidebarMode() === 'over') {
      this.setSidebarOpen(false);
    }
  }

  private setupResponsiveLayout(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia('(min-width: 900px)');
    const update = (matches: boolean): void => this.sidebarMode.set(matches ? 'side' : 'over');
    const handler = (e: MediaQueryListEvent): void => update(e.matches);

    update(mql.matches);
    mql.addEventListener('change', handler);
    this.destroyRef.onDestroy(() => mql.removeEventListener('change', handler));
  }

  setSubMode(mode: FlowSubMode | string): void {
    const resolved = mode === 'builder' ? 'builder' : 'quick_run';
    this.uiStateService.endLayoutEdit();
    this.activeSubMode.set(resolved);
    this.localStorage.set('ui.flowActiveSubMode', resolved);
  }

  /** Open the remote configuration modal to create a new remote only. */
  newRemote(): void {
    this.modalService.openRemoteConfig({ editTarget: 'remote' });
    this.closeSidebarIfOver();
  }

  /** Open the quick-run editor in "create" mode. */
  newQuickRun(): void {
    this.setSubMode('quick_run');
    this.quickRunService.openEditor();
    this.closeSidebarIfOver();
  }

  /** Switch to the Workflow Builder tab and create a fresh workflow. */
  newWorkflow(): void {
    this.setSubMode('builder');
    this.workflowState.createNewWorkflow();
    this.closeSidebarIfOver();
  }

  onQuickRunSelected(): void {
    this.setSubMode('quick_run');
  }

  onWorkflowSelected(): void {
    this.setSubMode('builder');
  }

  onItemSelected(): void {
    this.closeSidebarIfOver();
  }
}
