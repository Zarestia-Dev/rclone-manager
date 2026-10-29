import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WorkflowEventService } from './workflow-event.service';
import { WorkflowStateService } from './workflow-state.service';
import { WorkflowEngineService } from './workflow-engine.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type { WorkflowNodeStatePayload, WorkflowExecutionStatePayload } from '@app/types';
import type { WorkflowDefinition } from '../../flow/workflow/types/workflow.types';

describe('WorkflowEventService', () => {
  let service: WorkflowEventService;
  let stateService: WorkflowStateService;
  let engineService: WorkflowEngineService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        WorkflowEventService,
        WorkflowStateService,
        WorkflowEngineService,
        {
          provide: ApiClientService,
          useValue: {
            invoke: vi.fn().mockResolvedValue(null),
          },
        },
        {
          provide: EventListenersService,
          useValue: {
            listenToWorkflowNodeStateChanged: vi.fn().mockReturnValue(new Subject()),
            listenToWorkflowExecutionStateChanged: vi.fn().mockReturnValue(new Subject()),
          },
        },
      ],
    });

    stateService = TestBed.inject(WorkflowStateService);
    engineService = TestBed.inject(WorkflowEngineService);
    service = TestBed.inject(WorkflowEventService);
  });

  function loadWorkflowWithNode(): {
    workflow: WorkflowDefinition;
    node: WorkflowDefinition['nodes'][number];
  } {
    const node: WorkflowDefinition['nodes'][number] = {
      id: 'n1',
      type: 'manual',
      category: 'trigger',
      title: 'Manual Trigger',
      x: 0,
      y: 0,
      inputs: [],
      outputs: [],
      config: {},
    };
    const workflow: WorkflowDefinition = {
      id: 'wf-events',
      name: 'Events',
      showOnTray: false,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [node],
      edges: [],
    };
    stateService.loadWorkflow(workflow);
    return { workflow, node };
  }

  it('initializes and handles node state changes', () => {
    const { workflow, node } = loadWorkflowWithNode();
    const payload: WorkflowNodeStatePayload = {
      workflowId: workflow.id,
      nodeId: node.id,
      state: 'success',
      durationMs: 120,
    };

    (
      service as unknown as { handleNodeStateChanged: (p: WorkflowNodeStatePayload) => void }
    ).handleNodeStateChanged(payload);

    const updatedNode = stateService.currentWorkflow()?.nodes.find(n => n.id === node.id);
    expect(updatedNode?.state).toBe('success');
    expect(updatedNode?.lastDurationMs).toBe(120);
    expect(engineService.logs().length).toBeGreaterThan(0);
  });

  it('handles execution state changes', () => {
    const payload: WorkflowExecutionStatePayload = {
      workflowId: 'wf-123',
      state: 'running',
      progress: {
        total: 5,
        completed: 2,
        currentStepTitle: 'Step 3',
      },
      message: 'Running step 3',
    };

    (
      service as unknown as {
        handleExecutionStateChanged: (p: WorkflowExecutionStatePayload) => void;
      }
    ).handleExecutionStateChanged(payload);

    expect(engineService.executionProgress()).toEqual({
      total: 5,
      completed: 2,
      currentStepTitle: 'Step 3',
    });
    expect(engineService.logs().some(l => l.message?.includes('Running step 3'))).toBe(true);
  });

  describe('with translations', () => {
    beforeEach(() => {
      const translate = TestBed.inject(TranslateService);
      translate.setTranslation('en', {
        backendErrors: {
          workflow: {
            jobStopped: 'Job {{id}} was stopped',
            startingWorkflow: 'Starting workflow',
            completedSuccessfully: "Workflow '{{name}}' completed successfully",
          },
        },
        flow: {
          workflow: {
            logs: {
              stepFailed: 'Step "{{title}}" failed: {{error}}',
              stepCompleted: 'Step "{{title}}" completed in {{duration}}ms',
            },
          },
        },
      });
      translate.use('en');
    });

    it('shows a backend error key translated on the node and in the log', () => {
      const { workflow, node } = loadWorkflowWithNode();

      (
        service as unknown as { handleNodeStateChanged: (p: WorkflowNodeStatePayload) => void }
      ).handleNodeStateChanged({
        workflowId: workflow.id,
        nodeId: node.id,
        state: 'failed',
        errorMessage: '{"key":"backendErrors.workflow.jobStopped","params":{"id":"7"}}',
      });

      expect(stateService.currentWorkflow()?.nodes[0].errorMessage).toBe('Job 7 was stopped');
      expect(engineService.logs().at(-1)?.message).toBe(
        `Step "${node.title}" failed: Job 7 was stopped`
      );
    });

    it('keeps plain error text from rclone untouched', () => {
      const { workflow, node } = loadWorkflowWithNode();

      (
        service as unknown as { handleNodeStateChanged: (p: WorkflowNodeStatePayload) => void }
      ).handleNodeStateChanged({
        workflowId: workflow.id,
        nodeId: node.id,
        state: 'failed',
        errorMessage: 'Failed to copy: disk full',
      });

      expect(stateService.currentWorkflow()?.nodes[0].errorMessage).toBe(
        'Failed to copy: disk full'
      );
    });

    it('translates the progress title and the run message', () => {
      (
        service as unknown as {
          handleExecutionStateChanged: (p: WorkflowExecutionStatePayload) => void;
        }
      ).handleExecutionStateChanged({
        workflowId: 'wf-1',
        state: 'completed',
        progress: {
          total: 1,
          completed: 1,
          currentStepTitle: 'backendErrors.workflow.startingWorkflow',
        },
        message:
          '{"key":"backendErrors.workflow.completedSuccessfully","params":{"name":"Backup"}}',
      });

      expect(engineService.logs().at(-1)?.message).toBe("Workflow 'Backup' completed successfully");
    });
  });
});
