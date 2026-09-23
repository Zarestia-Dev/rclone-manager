import { inject, Injectable } from '@angular/core';
import { Automation, JobInfo, Remote, ServeListItem, AppTab, QuickRun } from '@app/types';
import { UiStateService } from './state/ui-state.service';
import { RemoteFacadeService } from '../facade/remote-facade.service';
import { PathService } from '../infrastructure/platform/path.service';
import { QuickRunService } from '../flow/quick-run.service';
import { WorkflowStorageService } from '../flow/workflow-storage.service';
import { WorkflowStateService } from '../flow/workflow-state.service';

/**
 * Dispatches centralized UI navigation requests across main views, tabs,
 * remotes, and quick runs from overview panels or global actions.
 */
@Injectable({
  providedIn: 'root',
})
export class NavigationDispatcherService {
  private readonly uiStateService = inject(UiStateService);
  private readonly remoteFacade = inject(RemoteFacadeService);
  private readonly pathService = inject(PathService);
  private readonly quickRunService = inject(QuickRunService);
  private readonly workflowStorage = inject(WorkflowStorageService);
  private readonly workflowState = inject(WorkflowStateService);

  /**
   * Navigates directly to a workflow on the Flow canvas.
   */
  navigateToWorkflow(workflowId?: string, workflowName?: string): void {
    this.uiStateService.setMainView('flow');
    const wf = this.workflowStorage
      .workflows()
      .find(w => (workflowId && w.id === workflowId) || (workflowName && w.name === workflowName));
    if (wf) {
      this.workflowState.loadWorkflow(wf);
    }
  }

  /**
   * Navigate to the appropriate view and tab for a running or completed job.
   */
  navigateToJob(job: JobInfo): void {
    if (job.origin === 'flow') {
      const wfId = job.workflow_id || job.profile;
      this.navigateToWorkflow(wfId);
      return;
    }

    if (job.origin === 'quickrun') {
      const qr = this.findQuickRun(job.profile);
      if (qr) {
        this.navigateToQuickRun(qr.id);
      }
      return;
    }

    const remoteName = job.remote_name;
    if (remoteName) {
      const tab: AppTab =
        job.job_type === 'mount' ? 'mount' : job.job_type === 'serve' ? 'serve' : 'operations';
      this.navigateToRemote(remoteName, tab);
    }
  }

  /**
   * Navigate to the serve tab for the remote hosting the given serve instance.
   */
  navigateToServe(serve: ServeListItem): void {
    const remoteName = this.pathService.getRemoteNameFromFs(serve.params?.fs);
    if (remoteName) {
      this.navigateToRemote(remoteName, 'serve');
      return;
    }

    if (serve.profile) {
      const qr = this.findQuickRun(serve.profile);
      if (qr) {
        this.navigateToQuickRun(qr.id);
      }
    }
  }

  /**
   * Navigate to the remote, Quick Run, or Workflow corresponding to the given automation.
   */
  navigateToAutomation(automation: Automation): void {
    if (automation.args?.source === 'flow') {
      this.navigateToWorkflow(automation.id, automation.profileName);
      return;
    }

    const remoteName = automation.remoteName || automation.args?.remoteName;
    if (remoteName && remoteName !== 'Workflow') {
      this.navigateToRemote(remoteName, 'operations');
      return;
    }

    const qr = this.findQuickRun(automation.profileName);
    if (qr) {
      this.navigateToQuickRun(qr.id);
    }
  }

  /**
   * Helper to navigate directly to a remote and optionally select a tab.
   */
  navigateToRemote(remoteOrName: Remote | string, tab: AppTab = 'general'): void {
    const remote =
      typeof remoteOrName === 'string'
        ? this.remoteFacade.activeRemotes().find(r => r.name === remoteOrName)
        : remoteOrName;

    if (remote) {
      this.uiStateService.setMainView('main_menu');
      this.uiStateService.setTab(tab);
      this.uiStateService.setSelectedRemote(remote);
    }
  }

  /**
   * Helper to navigate directly to Flow and select a Quick Run by ID.
   */
  navigateToQuickRun(quickRunId: string): void {
    this.uiStateService.setMainView('flow');
    this.workflowState.requestedSubMode.set('quick_run');
    this.quickRunService.select(quickRunId);
  }

  private findQuickRun(idOrName?: string): QuickRun | undefined {
    if (!idOrName) return undefined;
    return this.quickRunService.quickRuns().find(q => q.id === idOrName || q.name === idOrName);
  }
}
