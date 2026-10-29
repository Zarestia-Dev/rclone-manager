import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { WorkflowStateService } from './workflow-state.service';
import { WorkflowEngineService } from './workflow-engine.service';
import type { WorkflowNodeStatePayload, WorkflowExecutionStatePayload } from '@app/types';

@Injectable({ providedIn: 'root' })
export class WorkflowEventService extends TauriBaseService {
  private readonly stateService = inject(WorkflowStateService);
  private readonly engineService = inject(WorkflowEngineService);
  private readonly eventListeners = inject(EventListenersService);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    super();
    this.setupEventListeners();
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
  }

  private handleNodeStateChanged(payload: WorkflowNodeStatePayload): void {
    // Backend errors arrive as translation keys; the interface shows them translated.
    const errorMessage = payload.errorMessage
      ? this.backendTranslation.translateBackendMessage(payload.errorMessage)
      : undefined;
    const currentWf = this.stateService.currentWorkflow();
    if (currentWf && currentWf.id === payload.workflowId) {
      this.stateService.updateNodeExecutionState(
        payload.nodeId,
        payload.state,
        errorMessage,
        payload.durationMs,
        payload.output
      );
    }

    const targetNode = currentWf?.nodes.find(n => n.id === payload.nodeId);
    const nodeTitle = targetNode ? targetNode.title : payload.nodeId;

    // Update active edges leading to / from this node for animated wire pulse flow
    if (currentWf) {
      if (payload.state === 'running') {
        const activeEdges = currentWf.edges
          .filter(e => e.targetNodeId === payload.nodeId || e.sourceNodeId === payload.nodeId)
          .map(e => e.id);
        this.engineService.activeEdgeIds.update(set => {
          const next = new Set(set);
          activeEdges.forEach(id => next.add(id));
          return next;
        });
      } else if (
        payload.state === 'success' ||
        payload.state === 'failed' ||
        payload.state === 'skipped'
      ) {
        const removeEdges = currentWf.edges
          .filter(e => e.targetNodeId === payload.nodeId)
          .map(e => e.id);
        this.engineService.activeEdgeIds.update(set => {
          const next = new Set(set);
          removeEdges.forEach(id => next.delete(id));
          return next;
        });
      }
    }

    if (payload.state === 'running') {
      this.engineService.log(
        payload.workflowId,
        this.translate.instant('flow.workflow.logs.stepRunning', { title: nodeTitle }),
        'info',
        targetNode
      );
    } else if (payload.state === 'success') {
      this.engineService.log(
        payload.workflowId,
        this.translate.instant('flow.workflow.logs.stepCompleted', {
          title: nodeTitle,
          duration: payload.durationMs ?? 0,
        }),
        'success',
        targetNode
      );
    } else if (payload.state === 'failed') {
      this.engineService.log(
        payload.workflowId,
        this.translate.instant('flow.workflow.logs.stepFailed', {
          title: nodeTitle,
          error: errorMessage ?? this.translate.instant('flow.workflow.logs.unknownError'),
        }),
        'error',
        targetNode,
        errorMessage
      );
    } else if (payload.state === 'skipped') {
      this.engineService.log(
        payload.workflowId,
        this.translate.instant('flow.workflow.logs.stepSkipped', { title: nodeTitle }),
        'info',
        targetNode
      );
    }
  }

  private handleExecutionStateChanged(payload: WorkflowExecutionStatePayload): void {
    if (payload.state === 'started') {
      this.engineService.isExecuting.set(true);
    } else if (
      payload.state === 'completed' ||
      payload.state === 'failed' ||
      payload.state === 'cancelled'
    ) {
      this.engineService.isExecuting.set(false);
      this.engineService.executionProgress.set(null);
      this.engineService.activeEdgeIds.set(new Set());
    }

    if (payload.progress) {
      this.engineService.executionProgress.set({
        ...payload.progress,
        currentStepTitle: this.backendTranslation.translateBackendMessage(
          payload.progress.currentStepTitle
        ),
      });
    }

    if (payload.message) {
      const severity =
        payload.state === 'completed'
          ? 'success'
          : payload.state === 'failed'
            ? 'error'
            : payload.state === 'cancelled'
              ? 'warn'
              : 'info';
      this.engineService.log(
        payload.workflowId,
        this.backendTranslation.translateBackendMessage(payload.message),
        severity
      );
    }
  }
}
