import { Injectable, computed, inject, signal } from '@angular/core';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import {
  WorkflowDefinition,
  WorkflowLogEntry,
  WorkflowLogSeverity,
  WorkflowNode,
} from '../../flow/workflow/types/workflow.types';
import { toPersistableWorkflow } from '../../flow/workflow/utils/workflow-persist.util';
import { generatePrefixedId } from '../../shared/utils';
import { WorkflowStateService } from './workflow-state.service';

interface WorkflowExecutionResultDto {
  workflowId: string;
  success: boolean;
  totalNodes: number;
  completedNodes: number;
  failedNodes: number;
  skippedNodes: number;
  durationMs: number;
  dryRun?: boolean;
  error?: string;
}

export interface WorkflowExecutionProgress {
  total: number;
  completed: number;
  currentStepTitle: string;
}

/** What is live about one running workflow. */
interface WorkflowRunState {
  dryRun: boolean;
  progress: WorkflowExecutionProgress | null;
  activeEdgeIds: ReadonlySet<string>;
}

/** Most log entries kept; the oldest go first. */
const MAX_LOG_ENTRIES = 1000;

const NO_EDGES: ReadonlySet<string> = new Set();

@Injectable({ providedIn: 'root' })
export class WorkflowEngineService extends TauriBaseService {
  private readonly stateService = inject(WorkflowStateService);

  /** Workflows are started by the user, a schedule, a watcher or a job, so several can run at once. */
  private readonly runs = signal<ReadonlyMap<string, WorkflowRunState>>(new Map());
  private readonly currentWorkflowId = computed(() => this.stateService.currentWorkflow()?.id);
  private readonly currentRun = computed(() => {
    const id = this.currentWorkflowId();
    return id === undefined ? undefined : this.runs().get(id);
  });

  /** The workflow on the canvas is running. */
  readonly isExecuting = computed(() => this.currentRun() !== undefined);
  readonly isDryRun = computed(() => this.currentRun()?.dryRun ?? false);
  readonly executionProgress = computed(() => this.currentRun()?.progress ?? null);
  readonly activeEdgeIds = computed(() => this.currentRun()?.activeEdgeIds ?? NO_EDGES);

  readonly logs = signal<WorkflowLogEntry[]>([]);

  isRunning(workflowId: string): boolean {
    return this.runs().has(workflowId);
  }

  /** Marks a workflow as running. A run already known keeps what it knows. */
  beginRun(workflowId: string, dryRun = false): void {
    this.updateRuns(runs => {
      if (!runs.has(workflowId)) {
        runs.set(workflowId, { dryRun, progress: null, activeEdgeIds: NO_EDGES });
      }
    });
  }

  endRun(workflowId: string): void {
    this.updateRuns(runs => {
      runs.delete(workflowId);
    });
  }

  setProgress(workflowId: string, progress: WorkflowExecutionProgress): void {
    this.patchRun(workflowId, { progress });
  }

  /** Changes which wires of a running workflow pulse. */
  updateActiveEdges(workflowId: string, change: (edges: Set<string>) => void): void {
    const run = this.runs().get(workflowId);
    if (!run) return;
    const edges = new Set(run.activeEdgeIds);
    change(edges);
    this.patchRun(workflowId, { activeEdgeIds: edges });
  }

  private patchRun(workflowId: string, patch: Partial<WorkflowRunState>): void {
    this.updateRuns(runs => {
      const run = runs.get(workflowId);
      if (run) runs.set(workflowId, { ...run, ...patch });
    });
  }

  private updateRuns(change: (runs: Map<string, WorkflowRunState>) => void): void {
    const next = new Map(this.runs());
    change(next);
    this.runs.set(next);
  }

  /**
   * Clears the execution log buffer.
   */
  clearLogs(): void {
    this.logs.set([]);
  }

  /**
   * Appends an entry to the execution log.
   */
  log(
    workflowId: string,
    message: string,
    severity: WorkflowLogSeverity = 'info',
    node?: WorkflowNode,
    details?: unknown
  ): void {
    const entry: WorkflowLogEntry = {
      id: generatePrefixedId('log'),
      workflowId,
      nodeId: node?.id,
      nodeTitle: node?.title,
      timestamp: new Date(),
      severity,
      message,
      details,
    };
    this.logs.update(list => [...list.slice(1 - MAX_LOG_ENTRIES), entry]);
  }

  /**
   * Halts any active workflow execution via the Rust backend.
   */
  async stopWorkflow(workflowId?: string): Promise<void> {
    const id = workflowId ?? this.stateService.currentWorkflow()?.id;
    if (!id) return;

    this.log(id, this.translate.instant('flow.workflow.logs.cancelRequested'), 'warn');
    await this.invokeCommand('stop_workflow', { workflowId: id });
  }

  /**
   * Runs the given workflow DAG through the Rust backend execution engine.
   */
  async executeWorkflow(workflow: WorkflowDefinition, dryRun = false): Promise<boolean> {
    if (this.isRunning(workflow.id)) {
      console.warn('[WorkflowEngine] Execution already in progress');
      return false;
    }

    this.beginRun(workflow.id, dryRun);

    // Reset all node states in the UI to 'idle'
    const resetNodes = workflow.nodes.map(n => ({
      ...n,
      state: 'idle' as const,
      errorMessage: undefined,
      lastDurationMs: undefined,
    }));
    this.stateService.currentWorkflow.update(w =>
      w && w.id === workflow.id ? { ...w, nodes: resetNodes } : w
    );
    this.log(
      workflow.id,
      this.translate.instant(
        dryRun ? 'flow.workflow.logs.startSimulation' : 'flow.workflow.logs.startExecution',
        { name: workflow.name }
      ),
      'info'
    );

    try {
      await this.saveIfChanged(workflow);

      // Trigger backend execution engine
      const result = await this.invokeCommand<WorkflowExecutionResultDto>('execute_workflow', {
        workflowId: workflow.id,
        dryRun,
      });

      return result.success;
    } catch (err: unknown) {
      const error = this.backendTranslation.translateBackendMessage(err);
      this.log(
        workflow.id,
        this.translate.instant('flow.workflow.logs.executionError', { error }),
        'error'
      );
      return false;
    } finally {
      this.endRun(workflow.id);
    }
  }

  /**
   * The backend runs the stored definition, so edits made since the last save are stored
   * first. A workflow that is already stored as it is on the canvas is not written again.
   */
  private async saveIfChanged(workflow: WorkflowDefinition): Promise<void> {
    const onCanvas = this.stateService.currentWorkflow()?.id === workflow.id;
    if (onCanvas && !this.stateService.hasUnsavedChanges()) return;

    const persistable = toPersistableWorkflow(workflow);
    await this.invokeCommand('update_workflow', { workflow: persistable });
    if (onCanvas) this.stateService.markSaved(workflow);
  }
}
