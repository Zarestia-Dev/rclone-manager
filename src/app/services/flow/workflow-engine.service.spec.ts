import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WorkflowEngineService, WorkflowRunView } from './workflow-engine.service';
import { WorkflowStateService } from './workflow-state.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { WorkflowDefinition } from '../../flow/workflow/types/workflow.types';
import type { WorkflowRunSnapshot } from '@app/types';
import { provideTranslateService } from '@ngx-translate/core';
import { NotificationService } from '../ui/notification.service';

describe('WorkflowEngineService', () => {
  let service: WorkflowEngineService;
  let stateService: WorkflowStateService;
  let mockApiClient: {
    invoke: ReturnType<typeof vi.fn>;
  };
  let showError: ReturnType<typeof vi.spyOn>;

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
    showError = vi
      .spyOn(TestBed.inject(NotificationService), 'showError')
      .mockImplementation(vi.fn());
  });

  it('starts with isExecuting false', () => {
    expect(service.isExecuting()).toBe(false);
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
    // The backend announces every run; the interface does not say it a second time.
    expect(showError).not.toHaveBeenCalled();
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
    expect(showError).not.toHaveBeenCalled();
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
    expect(showError).toHaveBeenCalledOnce();
    expect(service.isExecuting()).toBe(false);
    expect(service.isDryRun()).toBe(false);
    expect(service.executionProgress()).toBeNull();
    expect(service.activeEdgeIds().size).toBe(0);
  });

  it('does not report a refused run a second time when the backend announced it', async () => {
    const wf: WorkflowDefinition = {
      id: 'wf-refused',
      name: 'Refused',
      showOnTray: false,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
    };
    stateService.loadWorkflow(wf);
    mockApiClient.invoke.mockImplementation((command: string) => {
      if (command !== 'execute_workflow') return Promise.resolve(null);
      // the failure event reaches the run before the command answers
      service.beginRun(wf.id, {
        runId: 'run-refused',
        dryRun: false,
        state: 'failed',
        startedAt: '2026-01-01T00:00:00.000Z',
        seq: 1,
        progress: null,
        steps: [],
        message: 'No nodes',
      });
      return Promise.reject('No nodes');
    });

    expect(await service.executeWorkflow(wf)).toBe(false);

    expect(showError).not.toHaveBeenCalled();
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

  it('treats a start that is not answered yet as executing, and refuses a second one', async () => {
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

    // The backend reports the run itself; until it does, the start is what is known.
    expect(service.isExecuting()).toBe(true);
    expect(await service.executeWorkflow(make('wf-a'))).toBe(false);

    finishFirst();
    await first;
    expect(service.isExecuting()).toBe(false);
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

  const openWorkflow = (): WorkflowDefinition => {
    const workflow = stateService.currentWorkflow();
    if (!workflow) throw new Error('No workflow on the canvas');
    return workflow;
  };

  it('resets the nodes of the workflow on the canvas before a run, and stores the view', async () => {
    const wf = stateService.createNewWorkflow('Run Reset');
    const node = stateService.addNode('manual', 'trigger', 'Start', 0, 0);
    stateService.recordNodeRun(wf.id, node.id, 'failed', 'old error', 9, { kept: true });
    stateService.setPan(40, 60);

    await service.executeWorkflow(openWorkflow());

    const shown = stateService.currentWorkflow()?.nodes[0];
    expect(shown?.state).toBe('idle');
    expect(shown?.errorMessage).toBeUndefined();
    expect(shown?.lastOutput).toEqual({ kept: true });
    const update = mockApiClient.invoke.mock.calls.find(c => c[0] === 'update_workflow');
    expect(update?.[1].workflow.viewport).toEqual(expect.objectContaining({ x: 40, y: 60 }));
  });

  describe('the runs it follows', () => {
    const view = (over: Partial<WorkflowRunView> = {}): WorkflowRunView => ({
      runId: 'run-1',
      dryRun: false,
      state: 'started',
      startedAt: '2026-01-01T00:00:00.000Z',
      seq: 1,
      progress: null,
      steps: [],
      ...over,
    });
    const event = (
      over: Partial<{ runId: string; seq: number; at: string }> = {}
    ): { runId: string; seq: number; at: string } => ({
      runId: 'run-1',
      seq: 2,
      at: '2026-01-01T00:00:01.000Z',
      ...over,
    });

    it('applies a run it has not seen only when it begins', () => {
      expect(service.judge('wf', event(), true)).toBe('apply');
      expect(service.judge('wf', event(), false)).toBe('unknown');
    });

    it('applies the next event of a run and drops one it has applied', () => {
      service.beginRun('wf', view({ seq: 2 }));
      expect(service.judge('wf', event({ seq: 3 }), false)).toBe('apply');
      expect(service.judge('wf', event({ seq: 2 }), false)).toBe('stale');
      expect(service.judge('wf', event({ seq: 1 }), false)).toBe('stale');
    });

    it('tells an older run from a newer one it missed the start of', () => {
      service.beginRun('wf', view());
      const other = { runId: 'run-0' };
      expect(service.judge('wf', event({ ...other, at: '2025-12-31T00:00:00.000Z' }), false)).toBe(
        'stale'
      );
      expect(service.judge('wf', event({ ...other }), false)).toBe('unknown');
      expect(service.judge('wf', event({ ...other }), true)).toBe('apply');
    });

    it('is live from the first event until the run ends', () => {
      service.beginRun('wf', view());
      expect(service.isRunning('wf')).toBe(true);
      service.advanceRun('wf', { seq: 5, state: 'running' });
      expect(service.isRunning('wf')).toBe(true);
      service.advanceRun('wf', { seq: 6, state: 'cancelled' });
      expect(service.isRunning('wf')).toBe(false);
      expect(service.runView('wf')?.seq).toBe(6);
    });

    it('adopts a snapshot that is later than what it knows and nothing else', () => {
      const snap = (over: Partial<WorkflowRunSnapshot>): WorkflowRunSnapshot => ({
        workflowId: 'wf',
        runId: 'run-1',
        dryRun: true,
        startedAt: '2026-01-01T00:00:00.000Z',
        state: 'completed',
        seq: 7,
        nodes: {},
        events: [],
        ...over,
      });
      service.beginRun('wf', view({ seq: 3 }));

      expect(service.adopt(snap({ seq: 3 }))).toBe(false);
      expect(service.adopt(snap({ runId: 'older', startedAt: '2025-12-31T00:00:00.000Z' }))).toBe(
        false
      );
      expect(service.runView('wf')?.state).toBe('started');

      expect(service.adopt(snap({}))).toBe(true);
      expect(service.runView('wf')).toMatchObject({ state: 'completed', seq: 7, dryRun: true });
      expect(service.adopt(snap({ runId: 'newer', startedAt: '2026-01-02T00:00:00.000Z' }))).toBe(
        true
      );
    });

    it('lists a step once, where it first reported', () => {
      service.beginRun('wf', view());
      service.advanceRun('wf', { seq: 2, stepId: 'b' });
      service.advanceRun('wf', { seq: 3, stepId: 'a' });
      service.advanceRun('wf', { seq: 4, stepId: 'b' });
      service.advanceRun('wf', { seq: 5, state: 'failed', message: 'Boom' });

      expect(service.runView('wf')).toMatchObject({
        steps: ['b', 'a'],
        state: 'failed',
        message: 'Boom',
      });
    });

    it('takes the order of the steps and the end message from a snapshot', () => {
      const node = { state: 'success' as const };
      const at = '2026-01-01T00:00:00.000Z';
      service.adopt({
        workflowId: 'wf',
        runId: 'run-1',
        dryRun: false,
        startedAt: at,
        state: 'failed',
        seq: 4,
        // 'gone' reported before its events were dropped from the snapshot
        nodes: { gone: node, a: node, b: node },
        events: [
          {
            kind: 'node',
            workflowId: 'wf',
            runId: 'run-1',
            seq: 1,
            at,
            nodeId: 'b',
            state: 'running',
          },
          {
            kind: 'node',
            workflowId: 'wf',
            runId: 'run-1',
            seq: 2,
            at,
            nodeId: 'a',
            state: 'running',
          },
          {
            kind: 'node',
            workflowId: 'wf',
            runId: 'run-1',
            seq: 3,
            at,
            nodeId: 'b',
            state: 'success',
          },
          {
            kind: 'execution',
            workflowId: 'wf',
            runId: 'run-1',
            seq: 4,
            at,
            state: 'failed',
            dryRun: false,
            message: 'Boom',
          },
        ],
      });

      expect(service.runView('wf')).toMatchObject({ steps: ['b', 'a', 'gone'], message: 'Boom' });
    });

    it('keeps only the runs the backend still has', () => {
      service.beginRun('a', view());
      service.beginRun('b', view());
      service.retainOnly(new Set(['b']));
      expect(service.runView('a')).toBeUndefined();
      expect(service.runView('b')).toBeDefined();
    });
  });
});
