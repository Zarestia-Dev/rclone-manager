import { LowerCasePipe, TitleCasePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { SearchContainerComponent } from '../../shared/components/search-container/search-container.component';

import { OPERATION_REGISTRY, QuickRun, Remote } from '@app/types';
import { WorkflowDefinition } from 'src/app/flow/workflow/types/workflow.types';

import { IconService } from 'src/app/services/ui/icon.service';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';
import { RemoteStatusService } from 'src/app/services/remote/remote-status.service';
import { RemoteFacadeService } from '../../services/facade/remote-facade.service';
import { formatCronHumanReadable } from '../../services/i18n/cron-locale.mapper';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';
import { WorkflowStorageService } from 'src/app/services/flow/workflow-storage.service';
import { WorkflowStateService } from 'src/app/services/flow/workflow-state.service';
import { WorkflowEngineService } from 'src/app/services/flow/workflow-engine.service';
import { TranslateService } from '@ngx-translate/core';

export type SidebarMode = 'remotes' | 'flow';

@Component({
  selector: 'app-sidebar',
  imports: [
    TitleCasePipe,
    LowerCasePipe,
    MatCardModule,
    MatIconModule,
    TranslatePipe,
    SearchContainerComponent,
  ],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SidebarComponent {
  readonly mode = input<SidebarMode>('remotes');
  readonly customTitle = input<string>();
  readonly customIcon = input<string>();
  readonly remotes = input<Remote[]>([]);
  readonly itemSelected = output<void>();
  readonly quickRunSelected = output<string>();
  readonly workflowSelected = output<WorkflowDefinition>();

  readonly iconService = inject(IconService);
  readonly statusService = inject(RemoteStatusService);
  private readonly uiStateService = inject(UiStateService);
  private readonly remoteFacade = inject(RemoteFacadeService);
  private readonly quickRunService = inject(QuickRunService);
  private readonly workflowStorage = inject(WorkflowStorageService);
  private readonly workflowState = inject(WorkflowStateService);
  private readonly workflowEngine = inject(WorkflowEngineService);
  private readonly translate = inject(TranslateService);

  readonly title = computed(
    () => this.customTitle() ?? (this.mode() === 'flow' ? 'flow.title' : 'sidebar.remotes')
  );
  readonly icon = computed(() => this.customIcon() ?? (this.mode() === 'flow' ? 'flow' : 'server'));
  readonly searchPlaceholder = computed(() =>
    this.mode() === 'flow' ? 'flow.search' : 'sidebar.searchPlaceholder'
  );
  readonly searchAriaLabel = computed(() =>
    this.mode() === 'flow' ? 'flow.search' : 'sidebar.searchAriaLabel'
  );
  readonly toggleSearchTitle = computed(() =>
    this.mode() === 'flow' ? 'flow.toggleSearch' : 'sidebar.toggleSearch'
  );

  // ── Unified loading & empty states ────────────────────────────────────────
  readonly isLoading = computed(() => {
    if (this.mode() === 'remotes') {
      return this.remoteFacade.loading();
    }
    return this.quickRunService.isLoading() || this.workflowStorage.isLoading();
  });

  readonly hasAny = computed(() => {
    if (this.mode() === 'remotes') {
      return this.remotes().length > 0;
    }
    return this.quickRuns().length > 0 || this.workflows().length > 0;
  });

  readonly emptyIcon = computed(() => (this.mode() === 'flow' ? 'flow' : 'server'));
  readonly emptyText = computed(() =>
    this.mode() === 'flow' ? 'flow.empty.description' : 'sidebar.noRemotesConfigured'
  );
  readonly loadingText = computed(() =>
    this.mode() === 'flow' ? 'flow.loading' : 'common.loading'
  );

  // ── Remotes state ─────────────────────────────────────────────────────────
  readonly selectedRemote = this.uiStateService.selectedRemote;
  readonly hiddenRemotesSet = computed(() => new Set(this.remoteFacade.hiddenRemoteNames()));

  // ── Quick-run state ───────────────────────────────────────────────────────
  readonly quickRuns = this.quickRunService.quickRuns;
  readonly selectedQuickRunId = this.quickRunService.selectedId;
  readonly runningIds = this.quickRunService.runningIds;

  // ── Workflow state ────────────────────────────────────────────────────────
  readonly workflows = this.workflowStorage.workflows;
  readonly selectedWorkflowId = computed(() => this.workflowState.currentWorkflow()?.id ?? null);

  // ── Search & Filter state ─────────────────────────────────────────────────
  readonly searchTerm = signal('');
  readonly searchVisible = signal(false);
  private readonly searchContainer = viewChild(SearchContainerComponent);

  readonly filteredRemotes = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    if (!term) return this.remotes();
    return this.remotes().filter(
      r => r.name.toLowerCase().includes(term) || r.type.toLowerCase().includes(term)
    );
  });

  readonly filteredQuickRuns = computed(() => {
    const query = this.searchTerm().toLowerCase().trim();
    if (!query) return this.quickRuns();
    return this.quickRuns().filter(qr => this.matchesQuickRunQuery(qr, query));
  });

  readonly filteredWorkflows = computed(() => {
    const query = this.searchTerm().toLowerCase().trim();
    if (!query) return this.workflows();
    return this.workflows().filter(wf => this.matchesWorkflowQuery(wf, query));
  });

  // ── Remotes actions ───────────────────────────────────────────────────────
  selectRemote(remote: Remote): void {
    this.uiStateService.setSelectedRemote(remote);
    this.itemSelected.emit();
  }

  // ── Quick-run actions ─────────────────────────────────────────────────────
  selectQuickRun(id: string): void {
    this.quickRunService.select(id);
    this.quickRunSelected.emit(id);
    this.itemSelected.emit();
  }

  isQuickRunRunning(id: string): boolean {
    return this.runningIds().has(id);
  }

  getQuickRunIcon(qr: QuickRun): string {
    const def = OPERATION_REGISTRY.find(d => d.key === qr.operationType);
    return def?.icon ?? 'operations';
  }

  getQuickRunActionLabel(qr: QuickRun): string {
    const def = OPERATION_REGISTRY.find(d => d.key === qr.operationType);
    return def?.actionLabel ?? 'flow.tabs.quickRun';
  }

  hasCron(qr: QuickRun): boolean {
    const app = qr.config?.app;
    return !!(app?.cronEnabled && app?.cronExpression);
  }

  hasWatcher(qr: QuickRun): boolean {
    return !!qr.config?.app?.watchEnabled;
  }

  hasAutoStart(qr: QuickRun): boolean {
    return !!qr.config?.app?.autoStart;
  }

  trackByQuickRunId(_index: number, qr: QuickRun): string {
    return qr.id;
  }

  // ── Workflow actions & helpers ───────────────────────────────────────────
  selectWorkflow(wf: WorkflowDefinition): void {
    this.workflowState.loadWorkflow(wf);
    this.workflowSelected.emit(wf);
    this.itemSelected.emit();
  }

  isWorkflowRunning(id: string): boolean {
    return this.workflowEngine.isExecuting() && this.workflowState.currentWorkflow()?.id === id;
  }

  hasAutoStartNode(wf: WorkflowDefinition): boolean {
    return (
      !!wf.autoStart ||
      wf.nodes.some(
        n => n.type === 'app_start' || (n.category === 'trigger' && n.type === 'app_start')
      )
    );
  }

  hasWatcherNode(wf: WorkflowDefinition): boolean {
    return wf.nodes.some(
      n => n.type === 'watcher' || (n.category === 'trigger' && n.type === 'watcher')
    );
  }

  getWorkflowCron(wf: WorkflowDefinition): string | null {
    if (wf.cronExpression && wf.cronExpression.trim()) {
      return wf.cronExpression.trim();
    }
    const cronNode = wf.nodes.find(
      n => n.type === 'cron' || (n.category === 'trigger' && n.type === 'cron')
    );
    const expr = cronNode?.config?.['cronExpression'];
    if (typeof expr === 'string' && expr.trim()) {
      return expr.trim();
    }
    return null;
  }

  hasCronNode(wf: WorkflowDefinition): boolean {
    return !!this.getWorkflowCron(wf);
  }

  getWorkflowTriggerIcon(wf: WorkflowDefinition): string {
    if (this.hasCronNode(wf)) {
      return 'clock';
    }
    if (this.hasWatcherNode(wf)) {
      return 'sync';
    }
    if (this.hasAutoStartNode(wf)) {
      return 'bolt';
    }
    const triggerNode = wf.nodes.find(n => n.category === 'trigger');
    if (triggerNode) {
      if (triggerNode.type === 'manual') return 'play';
      if (triggerNode.type === 'job_event') return 'done-all';
      if (triggerNode.icon) return triggerNode.icon;
    }
    return 'play';
  }

  getWorkflowTriggerSummary(wf: WorkflowDefinition): string {
    const cron = this.getWorkflowCron(wf);
    if (cron) {
      return cron;
    }
    const triggerNode = wf.nodes.find(n => n.category === 'trigger');
    if (triggerNode) {
      return triggerNode.title || triggerNode.subtitle || triggerNode.type;
    }
    return this.translate.instant('flow.workflow.recipes.manualTrigger');
  }

  getWorkflowTriggerTooltip(wf: WorkflowDefinition): string {
    const cron = this.getWorkflowCron(wf);
    if (cron) {
      try {
        const human = formatCronHumanReadable(cron, this.translate.getCurrentLang() ?? 'en-US');
        return `${human} (${cron})`;
      } catch {
        return cron;
      }
    }
    const triggerNode = wf.nodes.find(n => n.category === 'trigger');
    if (triggerNode) {
      if (triggerNode.type === 'manual') {
        return this.translate.instant('flow.workflow.recipes.manualTriggerDesc');
      }
      return triggerNode.subtitle || triggerNode.title || triggerNode.type;
    }
    return this.translate.instant('flow.workflow.recipes.manualTriggerDesc');
  }

  trackByWorkflowId(_index: number, wf: WorkflowDefinition): string {
    return wf.id;
  }

  private matchesWorkflowQuery(wf: WorkflowDefinition, query: string): boolean {
    const nodeTitles = wf.nodes.map(n => `${n.title} ${n.subtitle ?? ''} ${n.type}`).join(' ');
    const cron = this.getWorkflowCron(wf) ?? '';
    const haystack = [wf.name, wf.description ?? '', cron, nodeTitles].join(' ').toLowerCase();
    return haystack.includes(query);
  }

  private matchesQuickRunQuery(qr: QuickRun, query: string): boolean {
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

  // ── Common search methods ─────────────────────────────────────────────────
  onSearchTextChange(text: string): void {
    this.searchTerm.set(text);
  }

  toggleSearch(): void {
    this.searchVisible.update(v => !v);
    if (!this.searchVisible()) {
      this.clearSearch();
    }
  }

  clearSearch(): void {
    this.searchTerm.set('');
    this.searchContainer()?.clear();
  }
}
