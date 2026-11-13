import { Injectable, computed, inject, signal } from '@angular/core';
import type { WorkflowExecutionState, WorkflowRunProgress, WorkflowRunSnapshot } from '@app/types';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { WorkflowDefinition } from '../../flow/workflow/types/workflow.types';
import { toPersistableWorkflow } from '../../flow/workflow/utils/workflow-persist.util';
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

const isLive = (state: WorkflowExecutionState): boolean =>
  state === 'started' || state === 'running';

/**
 * The latest run of one workflow, as far as events and snapshots have told. The backend
 * owns the run; this is a view of it that can be rebuilt at any time (see `adopt`).
 */
export interface WorkflowRunView {
  runId: string;
  dryRun: boolean;
  state: WorkflowExecutionState;
  /** RFC 3339; when the run began. */
  startedAt: string;
  /** The `seq` of the last event applied. */
  seq: number;
  progress: WorkflowRunProgress | null;
  /** Ids of the steps that reported, in the order they first did. */
  steps: string[];
  /**
   * What the backend said about the run's end, e.g. why it failed. Kept as the backend sent it:
   * translations may not be loaded yet when it arrives, so it is translated where it is shown.
   */
  message?: string;
}

/** What to do with an event of a run. */
export type RunEventVerdict =
  /** It continues the run this view follows, or starts a newer one. */
  | 'apply'
  /** It is already known, or belongs to an older run. */
  | 'stale'
  /** It belongs to a run this view never saw begin: the view has to be rebuilt from a snapshot. */
  | 'unknown';

const NO_EDGES: ReadonlySet<string> = new Set();

@Injectable({ providedIn: 'root' })
export class WorkflowEngineService extends TauriBaseService {
  private readonly stateService = inject(WorkflowStateService);

  /** Workflows are started by the user, a schedule, a watcher or a job, so several can run at once. */
  private readonly runs = signal<ReadonlyMap<string, WorkflowRunView>>(new Map());
  /** Workflows whose start was asked for and not yet answered, with whether it is a simulation. */
  private readonly starting = signal<ReadonlyMap<string, boolean>>(new Map());
  private readonly currentWorkflowId = computed(() => this.stateService.currentWorkflow()?.id);
  /** The run of the workflow on the canvas, while it is live. */
  private readonly liveRun = computed(() => {
    const id = this.currentWorkflowId();
    const run = id === undefined ? undefined : this.runs().get(id);
    return run && isLive(run.state) ? run : undefined;
  });

  /** The workflow on the canvas is running. */
  readonly isExecuting = computed(() => {
    const id = this.currentWorkflowId();
    return id !== undefined && (this.liveRun() !== undefined || this.starting().has(id));
  });
  readonly isDryRun = computed(() => {
    const id = this.currentWorkflowId();
    return this.liveRun()?.dryRun ?? (id !== undefined && this.starting().get(id) === true);
  });
  readonly executionProgress = computed(() => this.liveRun()?.progress ?? null);
  /**
   * The wires that carry data right now: those into a step that is running, unless the step
   * before was skipped (it sent nothing). Derived from the steps, so it is right whenever
   * the steps are, however the view came to know them.
   */
  readonly activeEdgeIds = computed<ReadonlySet<string>>(() => {
    const workflow = this.stateService.currentWorkflow();
    if (!this.liveRun() || !workflow) return NO_EDGES;
    const states = new Map(workflow.nodes.map(n => [n.id, n.state]));
    return new Set(
      workflow.edges
        .filter(
          e => states.get(e.targetNodeId) === 'running' && states.get(e.sourceNodeId) !== 'skipped'
        )
        .map(e => e.id)
    );
  });

  isRunning(workflowId: string): boolean {
    const run = this.runs().get(workflowId);
    return run !== undefined && isLive(run.state);
  }

  /** The latest run of a workflow as this view knows it. */
  runView(workflowId: string): WorkflowRunView | undefined {
    return this.runs().get(workflowId);
  }

  /**
   * Decides what an event of a run means for this view. Events of a run arrive in order of
   * their `seq`; one at or below what the view has seen is already part of it.
   */
  judge(
    workflowId: string,
    event: { runId: string; seq: number; at: string },
    begins: boolean
  ): RunEventVerdict {
    const run = this.runs().get(workflowId);
    if (!run) return begins ? 'apply' : 'unknown';
    if (run.runId === event.runId) return event.seq > run.seq ? 'apply' : 'stale';
    if (event.at < run.startedAt) return 'stale';
    return begins ? 'apply' : 'unknown';
  }

  /** Follows a run from its first event. */
  beginRun(workflowId: string, run: WorkflowRunView): void {
    this.setRun(workflowId, run);
  }

  /** Records the progress and state an event of the followed run brought. */
  advanceRun(
    workflowId: string,
    change: Partial<Pick<WorkflowRunView, 'state' | 'progress' | 'message'>> & {
      seq: number;
      /** A step that reported; it is listed once, where it first did. */
      stepId?: string;
    }
  ): void {
    const run = this.runs().get(workflowId);
    if (!run) return;
    const { stepId, ...rest } = change;
    const steps =
      stepId === undefined || run.steps.includes(stepId) ? run.steps : [...run.steps, stepId];
    this.setRun(workflowId, { ...run, ...rest, steps });
  }

  /**
   * Takes over what the backend says about a workflow's latest run, unless this view already
   * knows the run better (a later event of it, or a later run). Returns whether it did.
   */
  adopt(snapshot: WorkflowRunSnapshot): boolean {
    const known = this.runs().get(snapshot.workflowId);
    const newer = known
      ? known.runId === snapshot.runId
        ? snapshot.seq > known.seq
        : snapshot.startedAt >= known.startedAt
      : true;
    if (!newer) return false;
    this.setRun(snapshot.workflowId, {
      runId: snapshot.runId,
      dryRun: snapshot.dryRun,
      state: snapshot.state,
      startedAt: snapshot.startedAt,
      seq: snapshot.seq,
      progress: snapshot.progress ?? null,
      steps: this.stepsOf(snapshot),
      message: this.messageOf(snapshot),
    });
    return true;
  }

  /** Forgets runs the backend no longer has (a restarted engine, a deleted workflow). */
  retainOnly(workflowIds: ReadonlySet<string>): void {
    const next = new Map([...this.runs()].filter(([id]) => workflowIds.has(id)));
    if (next.size !== this.runs().size) this.runs.set(next);
  }

  /** The steps a snapshot has seen, in order; the events come first, then steps whose events were dropped. */
  private stepsOf(snapshot: WorkflowRunSnapshot): string[] {
    const ids = snapshot.events.flatMap(e => (e.kind === 'node' ? [e.nodeId] : []));
    return [...new Set([...ids, ...Object.keys(snapshot.nodes)])];
  }

  /** What the run's last execution event said, as the backend sent it. */
  private messageOf(snapshot: WorkflowRunSnapshot): string | undefined {
    return snapshot.events
      .flatMap(e => (e.kind === 'execution' && e.message ? [e.message] : []))
      .at(-1);
  }

  private setRun(workflowId: string, run: WorkflowRunView): void {
    this.runs.set(new Map(this.runs()).set(workflowId, run));
  }

  private setStarting(workflowId: string, dryRun: boolean | null): void {
    const next = new Map(this.starting());
    if (dryRun === null) next.delete(workflowId);
    else next.set(workflowId, dryRun);
    this.starting.set(next);
  }

  /**
   * Halts any active workflow execution via the Rust backend.
   */
  async stopWorkflow(workflowId?: string): Promise<void> {
    const id = workflowId ?? this.stateService.currentWorkflow()?.id;
    if (!id) return;

    await this.invokeCommand('stop_workflow', { workflowId: id });
  }

  /**
   * Runs the given workflow DAG through the Rust backend execution engine.
   */
  async executeWorkflow(workflow: WorkflowDefinition, dryRun = false): Promise<boolean> {
    if (this.isRunning(workflow.id) || this.starting().has(workflow.id)) {
      console.warn('[WorkflowEngine] Execution already in progress');
      return false;
    }

    // Bridges the moment between the request and the backend's first word on the run, which
    // arrives as an event. The run itself is never tracked here: the backend reports it.
    this.setStarting(workflow.id, dryRun);
    this.stateService.resetRunResults(workflow.id);

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
      // A run the backend refused (a failed check) was announced by an event just before,
      // and the run summary shows it.
      const run = this.runs().get(workflow.id);
      if (
        run?.state === 'failed' &&
        run.message &&
        this.backendTranslation.translateBackendMessage(run.message) === error
      ) {
        return false;
      }
      this.notificationService.showError(
        this.translate.instant('flow.workflow.run.executionError', { error })
      );
      return false;
    } finally {
      this.setStarting(workflow.id, null);
    }
  }

  /**
   * The backend runs the stored definition, so edits made since the last save are stored
   * first. A workflow that is already stored as it is on the canvas is not written again.
   */
  private async saveIfChanged(workflow: WorkflowDefinition): Promise<void> {
    const onCanvas = this.stateService.currentWorkflow()?.id === workflow.id;
    if (onCanvas && !this.stateService.hasUnsavedChanges()) return;

    const stored = onCanvas ? (this.stateService.workflowToStore() ?? workflow) : workflow;
    const persistable = toPersistableWorkflow(stored);
    await this.invokeCommand('update_workflow', { workflow: persistable });
    if (onCanvas) this.stateService.markSaved(workflow);
  }
}
