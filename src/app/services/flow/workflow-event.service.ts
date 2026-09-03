import { Injectable, inject } from '@angular/core';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { WorkflowStateService } from './workflow-state.service';
import { WorkflowEngineService } from './workflow-engine.service';
import { WorkflowNodeExecutionState } from '../../flow/workflow/types/workflow.types';

export interface WorkflowNodeStatePayload {
  workflowId: string;
  nodeId: string;
  state: WorkflowNodeExecutionState;
  errorMessage?: string;
  durationMs?: number;
}

export interface WorkflowExecutionStatePayload {
  workflowId: string;
  state: 'started' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress?: {
    total: number;
    completed: number;
    currentStepTitle: string;
  };
  message?: string;
}

@Injectable({ providedIn: 'root' })
export class WorkflowEventService extends TauriBaseService {
  private readonly stateService = inject(WorkflowStateService);
  private readonly engineService = inject(WorkflowEngineService);

  constructor() {
    super();
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    this.listenToEvent<WorkflowNodeStatePayload>('workflow_node_state_changed').subscribe(
      payload => {
        if (!payload) return;
        this.handleNodeStateChanged(payload);
      }
    );

    this.listenToEvent<WorkflowExecutionStatePayload>('workflow_execution_state_changed').subscribe(
      payload => {
        if (!payload) return;
        this.handleExecutionStateChanged(payload);
      }
    );
  }

  private handleNodeStateChanged(payload: WorkflowNodeStatePayload): void {
    const currentWf = this.stateService.currentWorkflow();
    if (currentWf && currentWf.id === payload.workflowId) {
      this.stateService.updateNodeExecutionState(
        payload.nodeId,
        payload.state,
        payload.errorMessage,
        payload.durationMs
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
        `Step "${nodeTitle}" is executing...`,
        'info',
        targetNode
      );
    } else if (payload.state === 'success') {
      this.engineService.log(
        payload.workflowId,
        `Step "${nodeTitle}" completed in ${payload.durationMs ?? 0}ms`,
        'success',
        targetNode
      );
    } else if (payload.state === 'failed') {
      this.engineService.log(
        payload.workflowId,
        `Step "${nodeTitle}" failed: ${payload.errorMessage ?? 'Unknown error'}`,
        'error',
        targetNode,
        payload.errorMessage
      );
    } else if (payload.state === 'skipped') {
      this.engineService.log(
        payload.workflowId,
        `Step "${nodeTitle}" skipped (branch not taken)`,
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
      this.engineService.executionProgress.set(payload.progress);
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
      this.engineService.log(payload.workflowId, payload.message, severity);
    }
  }
}
