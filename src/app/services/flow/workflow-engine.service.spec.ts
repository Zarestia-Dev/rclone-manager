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
      showOnTray: false,
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
      showOnTray: false,
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
    expect(service.logs().some(l => l.message.includes('startSimulation'))).toBe(true);
  });

  it('handles backend execution errors gracefully', async () => {
    const wf: WorkflowDefinition = {
      id: 'wf-cyclic',
      name: 'Cyclic Test',
      showOnTray: false,
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
    expect(service.isExecuting()).toBe(false);
    expect(service.isDryRun()).toBe(false);
    expect(service.executionProgress()).toBeNull();
    expect(service.activeEdgeIds().size).toBe(0);
  });

  it('only stores the workflow before a run when it has unsaved edits', async () => {
    const wf: WorkflowDefinition = {
      id: 'wf-save',
      name: 'Save Test',
      showOnTray: false,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'n1',
          type: 'manual',
          category: 'trigger',
          title: 'Manual',
          x: 0,
          y: 0,
          inputs: [],
          outputs: [],
          config: {},
          lastOutput: { big: 'result of an earlier run' },
        },
      ],
      edges: [],
    };
    stateService.loadWorkflow(wf);

    await service.executeWorkflow(wf);
    expect(mockApiClient.invoke).not.toHaveBeenCalledWith('update_workflow', expect.anything());

    stateService.updateWorkflowMetadata({ name: 'Renamed' });
    expect(stateService.hasUnsavedChanges()).toBe(true);
    await service.executeWorkflow(stateService.currentWorkflow() as WorkflowDefinition);

    const saved = mockApiClient.invoke.mock.calls.find(call => call[0] === 'update_workflow');
    const sent = (saved?.[1] as { workflow: WorkflowDefinition }).workflow;
    expect(sent.name).toBe('Renamed');
    expect('lastOutput' in sent.nodes[0]).toBe(false);
    expect(stateService.hasUnsavedChanges()).toBe(false);
  });

  it('runs two workflows side by side and reports each on its own', async () => {
    let finishFirst!: () => void;
    mockApiClient.invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === 'execute_workflow' && args?.['workflowId'] === 'wf-a') {
        return new Promise<{ success: boolean }>(resolve => {
          finishFirst = (): void => resolve({ success: true });
        });
      }
      return Promise.resolve({ success: true });
    });
    const make = (id: string): WorkflowDefinition => ({
      id,
      name: id,
      showOnTray: false,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
    });
    stateService.loadWorkflow(make('wf-a'));

    const first = service.executeWorkflow(make('wf-a'));
    await service.executeWorkflow(make('wf-b'));

    expect(service.isRunning('wf-a')).toBe(true);
    expect(service.isRunning('wf-b')).toBe(false);
    expect(service.isExecuting()).toBe(true);

    finishFirst();
    await first;
    expect(service.isExecuting()).toBe(false);
  });

  it('keeps only the latest log entries', () => {
    for (let i = 0; i < 1100; i++) service.log('wf', `entry ${i}`);

    expect(service.logs().length).toBe(1000);
    expect(service.logs()[0].message).toBe('entry 100');
    expect(service.logs().at(-1)?.message).toBe('entry 1099');
  });

  it('calls backend stop_workflow when stopping', async () => {
    const wf: WorkflowDefinition = {
      id: 'wf-stop',
      name: 'Stop Test',
      showOnTray: false,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
    };
    stateService.loadWorkflow(wf);
    await service.stopWorkflow('wf-stop');

    expect(mockApiClient.invoke).toHaveBeenCalledWith('stop_workflow', { workflowId: 'wf-stop' });
  });
});
