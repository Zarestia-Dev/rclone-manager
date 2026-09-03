import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import {
  WorkflowEventService,
  WorkflowNodeStatePayload,
  WorkflowExecutionStatePayload,
} from './workflow-event.service';
import { WorkflowStateService } from './workflow-state.service';
import { WorkflowEngineService } from './workflow-engine.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { provideTranslateService } from '@ngx-translate/core';

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
      ],
    });

    stateService = TestBed.inject(WorkflowStateService);
    engineService = TestBed.inject(WorkflowEngineService);
    service = TestBed.inject(WorkflowEventService);
  });

  it('initializes and handles node state changes', () => {
    stateService.createNewWorkflow('Event Test');
    const currentWf = stateService.currentWorkflow();
    expect(currentWf).not.toBeNull();
    if (!currentWf || currentWf.nodes.length === 0) return;

    const nodeId = currentWf.nodes[0].id;
    const payload: WorkflowNodeStatePayload = {
      workflowId: currentWf.id,
      nodeId,
      state: 'success',
      durationMs: 120,
    };

    (
      service as unknown as { handleNodeStateChanged: (p: WorkflowNodeStatePayload) => void }
    ).handleNodeStateChanged(payload);

    const updatedNode = stateService.currentWorkflow()?.nodes.find(n => n.id === nodeId);
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
});
