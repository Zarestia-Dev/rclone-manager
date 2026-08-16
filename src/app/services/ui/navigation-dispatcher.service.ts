import { inject, Injectable } from '@angular/core';
import { Automation, JobInfo, Remote, ServeListItem, AppTab } from '@app/types';
import { UiStateService } from './state/ui-state.service';
import { RemoteFacadeService } from '../facade/remote-facade.service';
import { PathService } from '../infrastructure/platform/path.service';
import { QuickRunService } from '../flow/quick-run.service';

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

  /**
   * Navigate to the appropriate view and tab for a running or completed job.
   */
  navigateToJob(job: JobInfo): void {
    if (job.origin === 'quickrun' || job.origin === 'flow') {
      this.uiStateService.setMainView('flow');
      const qr = this.quickRunService
        .quickRuns()
        .find(q => q.id === job.profile || q.name === job.profile);
      if (qr) {
        this.quickRunService.select(qr.id);
      }
      return;
    }

    const remoteName = job.remote_name;
    if (remoteName) {
      const remote = this.remoteFacade.activeRemotes().find(r => r.name === remoteName);
      if (remote) {
        this.uiStateService.setMainView('main_menu');
        if (job.job_type === 'mount') {
          this.uiStateService.setTab('mount');
        } else if (job.job_type === 'serve') {
          this.uiStateService.setTab('serve');
        } else {
          this.uiStateService.setTab('operations');
        }
        this.uiStateService.setSelectedRemote(remote);
      }
    }
  }

  /**
   * Navigate to the serve tab for the remote hosting the given serve instance.
   */
  navigateToServe(serve: ServeListItem): void {
    const remoteName = this.pathService.getRemoteNameFromFs(serve.params?.fs);
    if (remoteName) {
      const remote = this.remoteFacade.activeRemotes().find(r => r.name === remoteName);
      if (remote) {
        this.uiStateService.setMainView('main_menu');
        this.uiStateService.setTab('serve');
        this.uiStateService.setSelectedRemote(remote);
        return;
      }
    }

    if (serve.profile) {
      const qr = this.quickRunService
        .quickRuns()
        .find(q => q.id === serve.profile || q.name === serve.profile);
      if (qr) {
        this.uiStateService.setMainView('flow');
        this.quickRunService.select(qr.id);
      }
    }
  }

  /**
   * Navigate to the remote or Quick Run corresponding to the given automation.
   */
  navigateToAutomation(automation: Automation): void {
    const remoteName = automation.remoteName || automation.args?.remoteName;
    if (remoteName) {
      const remote = this.remoteFacade.activeRemotes().find(r => r.name === remoteName);
      if (remote) {
        this.uiStateService.setMainView('main_menu');
        this.uiStateService.setTab('operations');
        this.uiStateService.setSelectedRemote(remote);
        return;
      }
    }

    const qr = this.quickRunService
      .quickRuns()
      .find(q => q.id === automation.profileName || q.name === automation.profileName);
    if (qr) {
      this.uiStateService.setMainView('flow');
      this.quickRunService.select(qr.id);
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
    this.quickRunService.select(quickRunId);
  }
}
