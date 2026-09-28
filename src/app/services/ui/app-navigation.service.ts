import { NautilusService } from './nautilus.service';
import { FlowOverlayService } from './flow-overlay.service';
import { MainUiOverlayService } from './main-ui-overlay.service';
import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { WorkflowStateService } from '../flow/workflow-state.service';
import { WorkflowStorageService } from '../flow/workflow-storage.service';
import { MainView } from '@app/types';
import { UiStateService } from './state/ui-state.service';
import { QuickRunService } from '../flow/quick-run.service';
import { RemoteFacadeService } from '../facade/remote-facade.service';
import { MainNavigation, NavigationHistoryService } from './navigation-history.service';

/** Connects domain stores to history without making them depend on one another. */
@Injectable({ providedIn: 'root' })
export class AppNavigationService {
  private readonly history = inject(NavigationHistoryService);
  private readonly ui = inject(UiStateService);
  private readonly quickRuns = inject(QuickRunService);
  private readonly remotes = inject(RemoteFacadeService);
  private readonly workflowState = inject(WorkflowStateService);
  private readonly workflowStorage = inject(WorkflowStorageService);
  private readonly pendingWorkflow = signal<string | null>(null);
  private readonly nautilus = inject(NautilusService);
  private readonly flowOverlay = inject(FlowOverlayService);
  private readonly mainOverlay = inject(MainUiOverlayService);
  private readonly started = signal(false);
  private readonly restoringWorkspace = signal(false);
  private workspaceRequest = 0;
  private readonly pendingRemote = signal<string | null>(null);

  constructor() {
    this.history.restored$.pipe(takeUntilDestroyed()).subscribe(({ main }) => {
      this.ui.setTab(main.tab);
      this.ui.setFlowSubMode(main.flowMode);
      const remote = this.remotes.activeRemotes().find(remote => remote.name === main.remote);
      this.pendingRemote.set(main.remote && !remote ? main.remote : null);
      this.ui.setSelectedRemote(remote ?? null);
      this.quickRuns.select(main.quickRun);
      this.pendingWorkflow.set(main.workflow);
      if (this.workflowState.currentWorkflow()?.id !== main.workflow)
        this.workflowState.currentWorkflow.set(null);
      void this.restoreWorkspace(main.view);
    });

    effect(() => {
      const name = this.pendingRemote();
      if (!name) return;
      if (this.ui.selectedRemote()) {
        this.pendingRemote.set(null);
        return;
      }
      const remote = this.remotes.activeRemotes().find(remote => remote.name === name);
      if (remote) {
        untracked(() => {
          this.ui.setSelectedRemote(remote);
          this.pendingRemote.set(null);
        });
      }
    });

    effect(() => {
      const id = this.pendingWorkflow();
      if (!id) return;
      if (this.workflowState.currentWorkflow()) {
        this.pendingWorkflow.set(null);
        return;
      }
      const workflow = this.workflowStorage.workflows().find(workflow => workflow.id === id);
      if (workflow) {
        untracked(() => {
          if (this.workflowState.currentWorkflow()?.id !== id)
            this.workflowState.loadWorkflow(workflow);
          this.pendingWorkflow.set(null);
        });
      }
    });

    effect(() => {
      if (!this.started() || this.restoringWorkspace()) return;
      const main = this.snapshot();
      untracked(() => this.history.updateMain(main));
    });
  }

  private async restoreWorkspace(view: MainView): Promise<void> {
    const request = ++this.workspaceRequest;
    this.restoringWorkspace.set(true);
    try {
      if (view !== this.ui.selectedMainView()) {
        if (view === 'nautilus') await this.nautilus.openBrowserOverlay(null, null);
        else if (view === 'flow') await this.flowOverlay.openFlowOverlay();
        else await this.mainOverlay.openMainUiOverlay();
      }
      if (request !== this.workspaceRequest) return;
      if (view !== 'nautilus' || view === this.ui.selectedMainView())
        this.nautilus.closeBrowserOverlay();
      if (view !== 'flow' || view === this.ui.selectedMainView())
        this.flowOverlay.closeFlowOverlay();
      if (view !== 'main_menu' || view === this.ui.selectedMainView())
        this.mainOverlay.closeMainUiOverlay();
    } catch (error) {
      if (request === this.workspaceRequest) {
        this.nautilus.closeBrowserOverlay();
        this.flowOverlay.closeFlowOverlay();
        this.mainOverlay.closeMainUiOverlay();
        this.ui.setMainView(view);
        console.error('Failed to restore workspace overlay:', error);
      }
    } finally {
      if (request === this.workspaceRequest) this.restoringWorkspace.set(false);
    }
  }

  initialize(standalone: MainView | null): void {
    if (standalone) this.ui.setMainView(standalone);
    this.history.initialize(this.snapshot(), standalone);
    this.started.set(true);
  }

  private snapshot(): MainNavigation {
    return {
      view: this.ui.activeWorkspace(),
      tab: this.ui.currentTab(),
      remote: this.ui.selectedRemote()?.name ?? this.pendingRemote(),
      quickRun: this.quickRuns.selectedId(),
      flowMode: this.ui.flowSubMode(),
      workflow: this.pendingWorkflow() ?? this.workflowState.currentWorkflow()?.id ?? null,
    };
  }
}
