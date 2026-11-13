import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { merge } from 'rxjs';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { WorkflowStateService } from './workflow-state.service';
import { WorkflowEngineService } from './workflow-engine.service';
import { CoalescedTask } from '../../shared/utils/coalesced-task.util';
import type {
  WorkflowNodeStatePayload,
  WorkflowExecutionStatePayload,
  WorkflowRunSnapshot,
} from '@app/types';

/**
 * Keeps the interface's picture of workflow runs equal to the backend's.
 *
 * The backend owns every run and reports each change as an event with a run id and a
 * sequence number. A picture built from events alone dies with the page, so it is also
 * rebuilt from a snapshot of the runs: at start, after the engine or the connection
 * came back, after a backend switch, and whenever an event shows a run was missed.
 * The sequence numbers let events and snapshots meet without applying anything twice.
 */
@Injectable({ providedIn: 'root' })
export class WorkflowEventService extends TauriBaseService {
  private readonly stateService = inject(WorkflowStateService);
  private readonly engineService = inject(WorkflowEngineService);
  private readonly eventListeners = inject(EventListenersService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly syncTask = new CoalescedTask(() => this.syncRuns());
  /** Events applied so far; a snapshot that was fetched while this moved may be older than the events. */
  private appliedEvents = 0;

  constructor() {
    super();
    this.setupEventListeners();
    void this.resync();
  }

  /** Rebuilds the picture of the runs from the backend. Concurrent calls share one request. */
  resync(): Promise<void> {
    return this.syncTask.run();
  }

  private async syncRuns(): Promise<void> {
    const appliedBefore = this.appliedEvents;
    try {
      const snapshots =
        (await this.invokeCommand<WorkflowRunSnapshot[] | null>('get_workflow_runs')) ?? [];
      snapshots.forEach(snapshot => this.applySnapshot(snapshot));
      // A run the backend does not have is over. An event that arrived while the answer was on
      // its way may have begun one the answer does not know yet, so then nothing is dropped.
      if (this.appliedEvents === appliedBefore) {
        this.engineService.retainOnly(new Set(snapshots.map(s => s.workflowId)));
      }
    } catch (error) {
      console.error('[WorkflowEventService] Failed to load workflow runs:', error);
    }
  }

  private applySnapshot(snapshot: WorkflowRunSnapshot): void {
    const id = snapshot.workflowId;
    const sameRun = this.engineService.runView(id)?.runId === snapshot.runId;
    if (!this.engineService.adopt(snapshot)) return;

    // A different run replaces what the last one left on the steps.
    if (!sameRun) this.stateService.resetRunResults(id);
    for (const [nodeId, node] of Object.entries(snapshot.nodes)) {
      this.recordNode(id, nodeId, node.state, node.errorMessage, node.durationMs, node.output);
    }
  }

  private setupEventListeners(): void {
    this.eventListeners
      .listenToWorkflowNodeStateChanged()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(payload => {
        if (!payload) return;
        this.handleNodeStateChanged(payload);
      });

    this.eventListeners
      .listenToWorkflowExecutionStateChanged()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(payload => {
        if (!payload) return;
        this.handleExecutionStateChanged(payload);
      });

    // Events are lost while the engine restarts, the backend changes or the connection is down.
    merge(
      this.eventListeners.listenToRcloneEngineReady(),
      this.eventListeners.listenToBackendSwitched(),
      this.eventListeners.listenToServerConnection()
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => void this.resync());
  }

  private handleNodeStateChanged(payload: WorkflowNodeStatePayload): void {
    const verdict = this.engineService.judge(payload.workflowId, payload, false);
    if (verdict === 'unknown') {
      void this.resync();
      return;
    }
    if (verdict === 'stale') return;

    this.appliedEvents++;
    this.engineService.advanceRun(payload.workflowId, {
      seq: payload.seq,
      stepId: payload.nodeId,
    });
    this.recordNode(
      payload.workflowId,
      payload.nodeId,
      payload.state,
      payload.errorMessage,
      payload.durationMs,
      payload.output
    );
  }

  private handleExecutionStateChanged(payload: WorkflowExecutionStatePayload): void {
    const id = payload.workflowId;
    const verdict = this.engineService.judge(id, payload, payload.state === 'started');
    if (verdict === 'unknown') {
      void this.resync();
      return;
    }
    if (verdict === 'stale') return;

    this.appliedEvents++;
    if (this.engineService.runView(id)?.runId !== payload.runId) {
      // A run the view has not followed: the steps start from nothing.
      this.stateService.resetRunResults(id);
      this.engineService.beginRun(id, {
        runId: payload.runId,
        dryRun: payload.dryRun,
        state: payload.state,
        startedAt: payload.at,
        seq: payload.seq,
        progress: payload.progress ?? null,
        steps: [],
        message: payload.message,
      });
    } else {
      this.engineService.advanceRun(id, {
        seq: payload.seq,
        state: payload.state,
        ...(payload.progress && { progress: payload.progress }),
        ...(payload.message && { message: payload.message }),
      });
    }
  }

  private recordNode(
    workflowId: string,
    nodeId: string,
    state: WorkflowNodeStatePayload['state'],
    errorMessage?: string,
    durationMs?: number,
    output?: unknown
  ): void {
    this.stateService.recordNodeRun(
      workflowId,
      nodeId,
      state,
      // Backend errors arrive as translation keys; they are translated where they are shown.
      errorMessage,
      durationMs,
      output
    );
  }
}
