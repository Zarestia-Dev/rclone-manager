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
  private standaloneView: MainView | null = null;
  private readonly pendingRemote = signal<string | null>(null);

  constructor() {
    this.history.restored$.pipe(takeUntilDestroyed()).subscribe(({ main }) => {
      this.ui.setTab(main.tab);
      this.ui.setFlowSubMode(main.flowMode);
      const remote = this.remotes.getRemote(main.remote);
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
      const remote = this.remotes.getRemote(name);
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
      // The base view needs no loading, so restoring it finishes in the same turn.
      if (view === this.baseView()) this.showBaseView(view);
      else await this.openWorkspace(view, () => request === this.workspaceRequest);
    } catch (error) {
      if (request === this.workspaceRequest) {
        this.closeOverlays();
        this.ui.setMainView(view);
        console.error('Failed to restore workspace overlay:', error);
      }
    } finally {
      if (request === this.workspaceRequest) this.restoringWorkspace.set(false);
    }
  }

  /**
   * The workspace that fills the window: the default view, or the one a standalone window was
   * opened for. Every other workspace is an overlay on top of it.
   */
  private baseView(): MainView {
    return this.standaloneView ?? this.ui.defaultView();
  }

  private showBaseView(view: MainView): void {
    this.closeOverlays();
    this.ui.setMainView(view);
  }

  private closeOverlays(): void {
    this.nautilus.closeBrowserOverlay();
    this.flowOverlay.closeOverlay();
    this.mainOverlay.closeOverlay();
  }

  /**
   * The one way to show a workspace, for the menu, for history and for every link that leads to
   * one. The base view is shown by closing the overlays; any other workspace opens as an overlay
   * on the base view and the other overlays close. Replacing the base view instead would make the
   * window open on the wrong workspace until it is reloaded. `isCurrent` lets a caller drop the
   * rest of the work when a newer request has started while the overlay was loading.
   */
  async openWorkspace(target: MainView, isCurrent: () => boolean = () => true): Promise<void> {
    if (target === this.baseView()) {
      this.showBaseView(target);
      return;
    }
    // Keep the current workspace visible until the target has finished loading.
    if (target === 'nautilus') await this.nautilus.openBrowserOverlay(null, null);
    else if (target === 'flow') await this.flowOverlay.openOverlay();
    else await this.mainOverlay.openOverlay();
    if (!isCurrent()) return;
    if (target !== 'nautilus') this.nautilus.closeBrowserOverlay();
    if (target !== 'flow') this.flowOverlay.closeOverlay();
    if (target !== 'main_menu') this.mainOverlay.closeOverlay();
  }

  initialize(standalone: MainView | null): void {
    this.standaloneView = standalone;
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
