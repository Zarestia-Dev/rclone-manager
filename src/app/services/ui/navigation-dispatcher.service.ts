import { inject, Injectable } from '@angular/core';
import {
  Automation,
  HasStarter,
  Remote,
  ServeListItem,
  AppTab,
  MainView,
  PrimaryActionType,
  QuickRun,
  profileOf,
  quickRunIdOf,
} from '@app/types';
import { UiStateService } from './state/ui-state.service';
import { AppNavigationService } from './app-navigation.service';
import { RemoteFacadeService } from '../facade/remote-facade.service';
import { PathService } from '../infrastructure/platform/path.service';
import { QuickRunService } from '../flow/quick-run.service';
import { WorkflowStorageService } from '../flow/workflow-storage.service';

/**
 * Dispatches centralized UI navigation requests across main views, tabs,
 * remotes, and quick runs from overview panels or global actions.
 */
@Injectable({
  providedIn: 'root',
})
export class NavigationDispatcherService {
  private readonly uiStateService = inject(UiStateService);
  private readonly navigation = inject(AppNavigationService);
  private readonly remoteFacade = inject(RemoteFacadeService);
  private readonly pathService = inject(PathService);
  private readonly quickRunService = inject(QuickRunService);
  private readonly workflowStorage = inject(WorkflowStorageService);

  /**
   * Navigates directly to a workflow on the Flow canvas.
   */
  navigateToWorkflow(workflowId?: string, workflowName?: string): void {
    this.uiStateService.setFlowSubMode('builder');
    const wf = this.workflowStorage
      .workflows()
      .find(w => (workflowId && w.id === workflowId) || (workflowName && w.name === workflowName));
    if (wf) void this.workflowStorage.openWorkflow(wf);
    this.show('flow');
  }

  /**
   * Navigate to the serve tab for the remote hosting the given serve instance, or to the Quick Run
   * or workflow that started it.
   */
  navigateToServe(serve: ServeListItem): void {
    this.navigateToOwner(serve, this.pathService.getRemoteNameFromFs(serve.params?.fs), 'serve');
  }

  /**
   * Navigate to the remote, Quick Run, or Workflow corresponding to the given automation.
   */
  navigateToAutomation(automation: Automation): void {
    if (automation.args?.source === 'workflow') {
      this.navigateToWorkflow(automation.id, automation.profileName);
      return;
    }

    if (automation.args?.source === 'quickrun') {
      const qr = this.findQuickRun(automation.id);
      if (qr) this.navigateToQuickRun(qr.id);
      return;
    }

    if (automation.remoteName) {
      this.navigateToRemote(
        automation.remoteName,
        'operations',
        automation.automationType && automation.profileName
          ? { operationType: automation.automationType, name: automation.profileName }
          : undefined
      );
    }
  }

  /**
   * Where a running serve or mount is shown: the tab of its remote, or its owner. A Quick Run or a workflow owns what it starts, and
   * the remote's tab lists only what its own profiles started, so that is where it is found.
   */
  navigateToOwner(item: HasStarter, remoteName: string | null, tab: AppTab): void {
    const quickRunId = quickRunIdOf(item);
    if (quickRunId) {
      this.navigateToQuickRun(quickRunId);
      return;
    }

    if (item.starter?.kind === 'workflow') {
      this.navigateToWorkflow(item.starter.workflowId, item.starter.workflowName);
      return;
    }

    if (!remoteName) return;
    // The profile that started a mount or serve is the card to open on the remote's tab.
    const profile = profileOf(item);
    this.navigateToRemote(
      remoteName,
      tab,
      profile && (tab === 'mount' || tab === 'serve')
        ? { operationType: tab, name: profile }
        : undefined
    );
  }

  /**
   * Helper to navigate directly to a remote and optionally select a tab. With a profile, the
   * remote's page also opens that profile instead of the one it showed last.
   */
  navigateToRemote(
    remoteOrName: Remote | string,
    tab: AppTab = 'general',
    profile?: { operationType: PrimaryActionType; name: string }
  ): void {
    const remote =
      typeof remoteOrName === 'string' ? this.remoteFacade.getRemote(remoteOrName) : remoteOrName;

    if (remote) {
      this.uiStateService.setTab(tab);
      if (profile) {
        this.uiStateService.requestProfile({
          remoteName: remote.name,
          operationType: profile.operationType,
          profile: profile.name,
        });
      }
      this.uiStateService.setSelectedRemote(remote);
      this.show('main_menu');
    }
  }

  /**
   * Helper to navigate directly to Flow and select a Quick Run by ID.
   */
  navigateToQuickRun(quickRunId: string): void {
    this.uiStateService.setFlowSubMode('quick_run');
    this.quickRunService.select(quickRunId);
    this.show('flow');
  }

  /** Shows a workspace the way the menu does, so the window's base view stays what it was set to. */
  private show(view: MainView): void {
    this.navigation
      .openWorkspace(view)
      .catch(error => console.error(`[Navigation] Could not open ${view}:`, error));
  }

  private findQuickRun(idOrName?: string): QuickRun | undefined {
    if (!idOrName) return undefined;
    return this.quickRunService.quickRuns().find(q => q.id === idOrName || q.name === idOrName);
  }
}
