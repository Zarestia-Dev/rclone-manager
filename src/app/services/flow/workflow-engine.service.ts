import { Injectable, inject, signal } from '@angular/core';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import {
  WorkflowDefinition,
  WorkflowLogEntry,
  WorkflowLogSeverity,
  WorkflowNode,
  WorkflowValidationResult,
} from '../../flow/workflow/types/workflow.types';
import { WorkflowStateService } from './workflow-state.service';

export interface WorkflowExecutionResultDto {
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

@Injectable({ providedIn: 'root' })
export class WorkflowEngineService extends TauriBaseService {
  private readonly stateService = inject(WorkflowStateService);

  readonly isExecuting = signal<boolean>(false);
  readonly isDryRun = signal<boolean>(false);
  readonly executionProgress = signal<{
    total: number;
    completed: number;
    currentStepTitle: string;
  } | null>(null);
  readonly logs = signal<WorkflowLogEntry[]>([]);
  readonly activeEdgeIds = signal<Set<string>>(new Set());

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
      id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      workflowId,
      nodeId: node?.id,
      nodeTitle: node?.title,
      timestamp: new Date(),
      severity,
      message,
      details,
    };
    this.logs.update(list => [...list, entry]);
  }

  /**
   * Halts any active workflow execution via the Rust backend.
   */
  async stopWorkflow(workflowId?: string): Promise<void> {
    const id = workflowId ?? this.stateService.currentWorkflow()?.id;
    if (!id) return;

    this.log(id, 'Workflow execution cancellation requested', 'warn');
    await this.invokeCommand('stop_workflow', { workflowId: id });
  }

  /**
   * Validates a workflow definition using the Rust backend DAG validator.
   */
  async validateWorkflow(workflow: WorkflowDefinition): Promise<WorkflowValidationResult> {
    return await this.invokeCommand<WorkflowValidationResult>('validate_workflow', { workflow });
  }

  /**
   * Runs the given workflow DAG through the Rust backend execution engine.
   */
  async executeWorkflow(workflow: WorkflowDefinition, dryRun = false): Promise<boolean> {
    if (this.isExecuting()) {
      console.warn('[WorkflowEngine] Execution already in progress');
      return false;
    }

    this.isExecuting.set(true);
    this.isDryRun.set(dryRun);
    this.activeEdgeIds.set(new Set());

    // Reset all node states in the UI to 'idle'
    const resetNodes = workflow.nodes.map(n => ({
      ...n,
      state: 'idle' as const,
      errorMessage: undefined,
      lastDurationMs: undefined,
    }));
    this.stateService.currentWorkflow.update(w => (w ? { ...w, nodes: resetNodes } : null));
    this.log(
      workflow.id,
      `Starting ${dryRun ? 'simulation (dry run)' : 'execution'} of workflow "${workflow.name}"`,
      'info'
    );

    try {
      // Save current definition first to ensure backend has latest state
      await this.invokeCommand('update_workflow', { workflow });

      // Trigger backend execution engine
      const result = await this.invokeCommand<WorkflowExecutionResultDto>('execute_workflow', {
        workflowId: workflow.id,
        dryRun,
      });

      return result.success;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(workflow.id, `Workflow execution error: ${msg}`, 'error');
      return false;
    } finally {
      this.isExecuting.set(false);
      this.isDryRun.set(false);
      this.executionProgress.set(null);
      this.activeEdgeIds.set(new Set());
    }
  }
}
