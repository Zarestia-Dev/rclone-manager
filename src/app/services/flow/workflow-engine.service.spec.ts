import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WorkflowEngineService } from './workflow-engine.service';
import { WorkflowStateService } from './workflow-state.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { WorkflowDefinition } from '../../flow/workflow/types/workflow.types';
import { provideTranslateService } from '@ngx-translate/core';

describe('WorkflowEngineService', () => {
  let service: WorkflowEngineService;
  let stateService: WorkflowStateService;
  let mockApiClient: {
    invoke: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockApiClient = {
      invoke: vi.fn().mockImplementation((command: string, args?: Record<string, unknown>) => {
        if (command === 'execute_workflow') {
          const id = args?.['workflowId'] as string;
          if (id === 'wf-cyclic') {
            return Promise.reject(
              new Error('Validation failed: Graph contains cyclic dependencies')
            );
          }
          return Promise.resolve({
            workflowId: id,
            success: true,
            totalNodes: 2,
            completedNodes: 2,
            failedNodes: 0,
            skippedNodes: 0,
            durationMs: 42,
          });
        }
        if (command === 'stop_workflow') {
          return Promise.resolve();
        }
        if (command === 'validate_workflow') {
          const wf = args?.['workflow'] as WorkflowDefinition;
          const valid = wf.id !== 'wf-cyclic';
          return Promise.resolve({
            valid,
            errors: valid ? [] : ['Cyclic graph'],
            warnings: [],
          });
        }
        if (command === 'update_workflow') {
          return Promise.resolve(args?.['workflow']);
        }
        return Promise.resolve(null);
      }),
    };

    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        WorkflowEngineService,
        WorkflowStateService,
        { provide: ApiClientService, useValue: mockApiClient },
      ],
    });

    service = TestBed.inject(WorkflowEngineService);
    stateService = TestBed.inject(WorkflowStateService);
  });

  it('starts with isExecuting false and empty logs', () => {
    expect(service.isExecuting()).toBe(false);
    expect(service.logs().length).toBe(0);
  });

  it('executes a workflow by delegating to the backend', async () => {
    const wf: WorkflowDefinition = {
      id: 'wf-test',
      name: 'Linear Test',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'n1',
          type: 'manual',
          category: 'trigger',
          title: 'Manual Trigger',
          x: 0,
          y: 0,
          inputs: [],
          outputs: [{ id: 'out', name: 'Trigger', type: 'out' }],
          config: {},
        },
        {
          id: 'n2',
          type: 'notification',
          category: 'action',
          title: 'Notify User',
          x: 300,
          y: 0,
          inputs: [{ id: 'in', name: 'In', type: 'in' }],
          outputs: [],
          config: { title: 'Test Done', message: 'Hello World', severity: 'success' },
        },
      ],
      edges: [
        {
          id: 'e1',
          sourceNodeId: 'n1',
          sourcePortId: 'out',
          targetNodeId: 'n2',
          targetPortId: 'in',
        },
      ],
    };

    stateService.loadWorkflow(wf);
    const success = await service.executeWorkflow(wf);

    expect(success).toBe(true);
    expect(mockApiClient.invoke).toHaveBeenCalledWith('execute_workflow', {
      workflowId: 'wf-test',
      dryRun: false,
    });
    expect(service.logs().length).toBeGreaterThan(0);
  });

  it('executes a workflow in simulation (dry-run) mode', async () => {
    const wf: WorkflowDefinition = {
      id: 'wf-dry-run',
      name: 'Dry Run Test',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'n1',
          type: 'manual',
          category: 'trigger',
          title: 'Manual Trigger',
          x: 0,
          y: 0,
          inputs: [],
          outputs: [{ id: 'out', name: 'Trigger', type: 'out' }],
          config: {},
        },
      ],
      edges: [],
    };

    stateService.loadWorkflow(wf);
    const success = await service.executeWorkflow(wf, true);

    expect(success).toBe(true);
    expect(mockApiClient.invoke).toHaveBeenCalledWith('execute_workflow', {
      workflowId: 'wf-dry-run',
      dryRun: true,
    });
    expect(service.logs().some(l => l.message.includes('simulation'))).toBe(true);
  });

  it('handles backend execution errors gracefully', async () => {
    const wf: WorkflowDefinition = {
      id: 'wf-cyclic',
      name: 'Cyclic Test',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'n1',
          type: 'sync',
          category: 'task',
          title: 'Sync 1',
          x: 0,
          y: 0,
          inputs: [{ id: 'in', name: 'In', type: 'in' }],
          outputs: [{ id: 'out', name: 'Out', type: 'out' }],
          config: { remote: 'my-remote' },
        },
      ],
      edges: [],
    };

    stateService.loadWorkflow(wf);
    const result = await service.executeWorkflow(wf);

    expect(result).toBe(false);
    expect(service.logs().some(l => l.severity === 'error')).toBe(true);
  });

  it('calls backend stop_workflow when stopping', async () => {
    const wf: WorkflowDefinition = {
      id: 'wf-stop',
      name: 'Stop Test',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
    };
    stateService.loadWorkflow(wf);
    await service.stopWorkflow('wf-stop');

    expect(mockApiClient.invoke).toHaveBeenCalledWith('stop_workflow', { workflowId: 'wf-stop' });
  });
});
