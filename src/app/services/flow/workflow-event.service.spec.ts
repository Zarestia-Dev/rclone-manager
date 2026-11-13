import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WorkflowEventService } from './workflow-event.service';
import { WorkflowStateService } from './workflow-state.service';
import { WorkflowEngineService } from './workflow-engine.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type {
  WorkflowNodeStatePayload,
  WorkflowExecutionStatePayload,
  WorkflowRunSnapshot,
} from '@app/types';
import type {
  WorkflowDefinition,
  WorkflowNode as WorkflowNodeDefinition,
} from '../../flow/workflow/types/workflow.types';

describe('WorkflowEventService', () => {
  let stateService: WorkflowStateService;
  let engineService: WorkflowEngineService;

  let invoke: ReturnType<typeof vi.fn>;
  let engineReady: Subject<void>;
  let backendSwitched: Subject<string>;
  let serverConnected: Subject<void>;
  let executionState: Subject<WorkflowExecutionStatePayload>;
  let nodeState: Subject<WorkflowNodeStatePayload>;

  function setup(
    runs: Promise<WorkflowRunSnapshot[] | null> | WorkflowRunSnapshot[] | null = null
  ): void {
    TestBed.resetTestingModule();
    invoke = vi
      .fn()
      .mockImplementation((command: string) =>
        command === 'get_workflow_runs' ? Promise.resolve(runs) : Promise.resolve(null)
      );
    engineReady = new Subject<void>();
    backendSwitched = new Subject<string>();
    serverConnected = new Subject<void>();
    executionState = new Subject<WorkflowExecutionStatePayload>();
    nodeState = new Subject<WorkflowNodeStatePayload>();
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        WorkflowEventService,
        WorkflowStateService,
        WorkflowEngineService,
        { provide: ApiClientService, useValue: { invoke } },
        {
          provide: EventListenersService,
          useValue: {
            listenToWorkflowNodeStateChanged: vi.fn().mockReturnValue(nodeState),
            listenToWorkflowExecutionStateChanged: vi.fn().mockReturnValue(executionState),
            listenToRcloneEngineReady: vi.fn().mockReturnValue(engineReady),
            listenToBackendSwitched: vi.fn().mockReturnValue(backendSwitched),
            listenToServerConnection: vi.fn().mockReturnValue(serverConnected),
          },
        },
      ],
    });

    stateService = TestBed.inject(WorkflowStateService);
    engineService = TestBed.inject(WorkflowEngineService);
    TestBed.inject(WorkflowEventService);
  }

  beforeEach(() => setup());

  const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve));

  // Every event of a run counts up, as the backend's do.
  const seqs = new Map<string, number>();
  const nextSeq = (runId: string): number => {
    const seq = (seqs.get(runId) ?? 0) + 1;
    seqs.set(runId, seq);
    return seq;
  };
  let clock = 0;
  const at = (): string => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, clock++)).toISOString();

  const execution = (
    workflowId: string,
    state: WorkflowExecutionStatePayload['state'],
    extra: Partial<WorkflowExecutionStatePayload> = {}
  ): WorkflowExecutionStatePayload => {
    const runId = extra.runId ?? `run-${workflowId}`;
    return { workflowId, runId, seq: nextSeq(runId), at: at(), state, dryRun: false, ...extra };
  };
  const node = (
    workflowId: string,
    nodeId: string,
    state: WorkflowNodeStatePayload['state'],
    extra: Partial<WorkflowNodeStatePayload> = {}
  ): WorkflowNodeStatePayload => {
    const runId = extra.runId ?? `run-${workflowId}`;
    return { workflowId, runId, seq: nextSeq(runId), at: at(), nodeId, state, ...extra };
  };
  const snapshot = (
    workflowId: string,
    extra: Partial<WorkflowRunSnapshot> = {}
  ): WorkflowRunSnapshot => ({
    workflowId,
    runId: `run-${workflowId}`,
    dryRun: false,
    startedAt: at(),
    state: 'running',
    seq: 1,
    nodes: {},
    events: [],
    ...extra,
  });

  beforeEach(() => {
    seqs.clear();
    clock = 0;
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

  it('handles node state changes of a followed run', () => {
    const { workflow, node: n } = loadWorkflowWithNode();
    executionState.next(execution(workflow.id, 'started'));
    nodeState.next(node(workflow.id, n.id, 'success', { durationMs: 120 }));

    const updatedNode = stateService.currentWorkflow()?.nodes.find(x => x.id === n.id);
    expect(updatedNode?.state).toBe('success');
    expect(updatedNode?.lastDurationMs).toBe(120);
    expect(engineService.runView(workflow.id)?.steps).toEqual([n.id]);
  });

  it('handles execution state changes', () => {
    const { workflow } = loadWorkflowWithNode();
    executionState.next(execution(workflow.id, 'started'));
    executionState.next(
      execution(workflow.id, 'running', {
        progress: { total: 5, completed: 2, currentStepTitle: 'Step 3' },
        message: 'Running step 3',
      })
    );

    expect(engineService.executionProgress()).toEqual({
      total: 5,
      completed: 2,
      currentStepTitle: 'Step 3',
    });
    expect(engineService.runView(workflow.id)?.message).toBe('Running step 3');
    expect(engineService.isExecuting()).toBe(true);
  });

  it('knows a simulation from the start event', () => {
    const { workflow } = loadWorkflowWithNode();
    executionState.next(execution(workflow.id, 'started', { dryRun: true }));
    expect(engineService.isDryRun()).toBe(true);

    executionState.next(execution(workflow.id, 'completed'));
    expect(engineService.isDryRun()).toBe(false);
  });

  it('ends a run on its final event and keeps what the steps showed', () => {
    const { workflow, node: n } = loadWorkflowWithNode();
    executionState.next(execution(workflow.id, 'started'));
    nodeState.next(node(workflow.id, n.id, 'failed', { errorMessage: 'boom' }));
    executionState.next(execution(workflow.id, 'failed'));

    expect(engineService.isRunning(workflow.id)).toBe(false);
    expect(engineService.isExecuting()).toBe(false);
    expect(stateService.currentWorkflow()?.nodes[0].state).toBe('failed');
  });

  describe('ordering', () => {
    it('ignores an event it has already applied', () => {
      const { workflow, node: n } = loadWorkflowWithNode();
      executionState.next(execution(workflow.id, 'started'));
      const running = node(workflow.id, n.id, 'running');
      nodeState.next(running);
      nodeState.next(node(workflow.id, n.id, 'success'));

      nodeState.next(running);

      expect(stateService.currentWorkflow()?.nodes[0].state).toBe('success');
    });

    it('ignores the late events of an older run', () => {
      const { workflow, node: n } = loadWorkflowWithNode();
      const old = { runId: 'run-old' };
      executionState.next(execution(workflow.id, 'started', old));
      const late = node(workflow.id, n.id, 'success', old);
      executionState.next(execution(workflow.id, 'completed', old));
      executionState.next(execution(workflow.id, 'started', { runId: 'run-new' }));

      nodeState.next(late);

      expect(stateService.currentWorkflow()?.nodes[0].state).toBe('idle');
      expect(engineService.runView(workflow.id)?.runId).toBe('run-new');
    });

    it('asks for the runs when an event belongs to a run it never saw begin', async () => {
      await flush();
      invoke.mockClear();

      nodeState.next(node('wf-missed', 'a', 'running'));
      await flush();

      expect(invoke).toHaveBeenCalledWith('get_workflow_runs', undefined);
      expect(engineService.isRunning('wf-missed')).toBe(false);
    });

    it('shows a run the backend refused, which had no start', async () => {
      setup([snapshot('wf-1', { state: 'failed', seq: 1 })]);
      await flush();
      expect(engineService.isRunning('wf-1')).toBe(false);
      expect(engineService.runView('wf-1')?.state).toBe('failed');
    });
  });

  describe('runs of other workflows', () => {
    it('do not change what the canvas shows for its own workflow', () => {
      const { workflow } = loadWorkflowWithNode();

      executionState.next(execution('wf-background', 'started'));
      expect(engineService.isExecuting()).toBe(false);
      expect(engineService.isRunning('wf-background')).toBe(true);

      executionState.next(execution(workflow.id, 'started'));
      expect(engineService.isExecuting()).toBe(true);

      // The background run ending does not end the one on the canvas.
      executionState.next(execution('wf-background', 'completed'));
      expect(engineService.isExecuting()).toBe(true);
      expect(engineService.isRunning('wf-background')).toBe(false);
    });

    it('keep their progress to themselves', () => {
      const { workflow } = loadWorkflowWithNode();
      executionState.next(execution(workflow.id, 'started'));
      executionState.next(execution('wf-background', 'started'));
      executionState.next(
        execution('wf-background', 'running', {
          progress: { total: 9, completed: 4, currentStepTitle: 'Elsewhere' },
        })
      );

      expect(engineService.executionProgress()).toBeNull();
    });

    it('do not touch the nodes or wires of a workflow with the same node ids', () => {
      const { workflow, node: n } = loadWorkflowWithNode();
      executionState.next(execution(workflow.id, 'started'));
      executionState.next(execution('wf-copy', 'started'));

      nodeState.next(node('wf-copy', n.id, 'running'));

      expect(stateService.currentWorkflow()?.nodes[0].state).not.toBe('running');
      expect(engineService.activeEdgeIds().size).toBe(0);
    });
  });

  describe('wire pulse', () => {
    const port = (
      id: string,
      type: 'in' | 'success' | 'failure'
    ): WorkflowNodeDefinition['inputs'][number] => ({
      id,
      name: id,
      type,
    });
    const stepNode = (
      id: string,
      inputs: WorkflowNodeDefinition['inputs'],
      outputs: WorkflowNodeDefinition['outputs']
    ): WorkflowNodeDefinition => ({
      id,
      type: 'sync',
      category: 'task',
      title: id,
      x: 0,
      y: 0,
      inputs,
      outputs,
      config: {},
    });
    const edge = (
      id: string,
      from: string,
      fromPort: string,
      to: string
    ): WorkflowDefinition['edges'][number] => ({
      id,
      sourceNodeId: from,
      sourcePortId: fromPort,
      targetNodeId: to,
      targetPortId: 'in',
    });
    const send = (nodeId: string, state: WorkflowNodeStatePayload['state']): void =>
      nodeState.next(node('wf-pulse', nodeId, state));

    /** a -success-> b, a -failure-> c, and b and c both lead into a join. */
    beforeEach(() => {
      stateService.loadWorkflow({
        id: 'wf-pulse',
        name: 'Pulse',
        showOnTray: false,
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [
          stepNode(
            'a',
            [port('in', 'in')],
            [port('success', 'success'), port('failure', 'failure')]
          ),
          stepNode('b', [port('in', 'in')], [port('success', 'success')]),
          stepNode('c', [port('in', 'in')], [port('success', 'success')]),
          stepNode('join', [port('in', 'in')], []),
        ],
        edges: [
          edge('a-b', 'a', 'success', 'b'),
          edge('a-c', 'a', 'failure', 'c'),
          edge('b-join', 'b', 'success', 'join'),
          edge('c-join', 'c', 'success', 'join'),
        ],
      });
      executionState.next(execution('wf-pulse', 'started'));
    });

    it('does not light the wires out of a running step, so an untaken branch never pulses', () => {
      send('a', 'running');
      expect([...engineService.activeEdgeIds()]).toEqual([]);

      send('a', 'success');
      send('b', 'running');
      expect([...engineService.activeEdgeIds()]).toEqual(['a-b']);
    });

    it('puts the wire out when its step finishes', () => {
      send('b', 'running');
      send('b', 'success');
      expect([...engineService.activeEdgeIds()]).toEqual([]);
    });

    it('lights a wire into a join only from the steps that ran', () => {
      send('c', 'skipped');
      send('join', 'running');
      expect([...engineService.activeEdgeIds()]).toEqual(['b-join']);
    });

    it('lights nothing once the run is over', () => {
      send('b', 'running');
      executionState.next(execution('wf-pulse', 'cancelled'));
      expect(engineService.activeEdgeIds().size).toBe(0);
    });
  });

  describe('runs of workflows that are not on the canvas', () => {
    const background = (): WorkflowDefinition => ({
      id: 'wf-background',
      name: 'Background',
      showOnTray: false,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'a',
          type: 'manual',
          category: 'trigger',
          title: 'Start',
          x: 0,
          y: 0,
          inputs: [],
          outputs: [],
          config: {},
        },
        {
          id: 'b',
          type: 'sync',
          category: 'task',
          title: 'Copy files',
          x: 0,
          y: 0,
          inputs: [],
          outputs: [],
          config: {},
        },
      ],
      edges: [
        { id: 'e1', sourceNodeId: 'a', sourcePortId: 'out', targetNodeId: 'b', targetPortId: 'in' },
      ],
    });

    it('show their node results when they are opened again', () => {
      const wf = background();
      loadWorkflowWithNode();

      executionState.next(execution(wf.id, 'started'));
      nodeState.next(node(wf.id, 'b', 'failed', { errorMessage: 'boom' }));
      stateService.loadWorkflow(wf);

      const found = stateService.currentWorkflow()?.nodes.find(n => n.id === 'b');
      expect(found?.state).toBe('failed');
      expect(found?.errorMessage).toBe('boom');
    });

    it('pulse their wires and list their steps', () => {
      const wf = background();
      loadWorkflowWithNode();

      executionState.next(execution(wf.id, 'started'));
      nodeState.next(node(wf.id, 'b', 'running'));
      stateService.loadWorkflow(wf);

      expect(engineService.activeEdgeIds().has('e1')).toBe(true);
      expect(engineService.runView(wf.id)?.steps).toEqual(['b']);
    });

    it('start from a clean slate when a new run is announced', () => {
      const { workflow, node: n } = loadWorkflowWithNode();
      executionState.next(execution(workflow.id, 'started', { runId: 'run-1' }));
      nodeState.next(node(workflow.id, n.id, 'failed', { runId: 'run-1', errorMessage: 'old' }));
      executionState.next(execution(workflow.id, 'failed', { runId: 'run-1' }));

      executionState.next(execution(workflow.id, 'started', { runId: 'run-2' }));

      const reset = stateService.currentWorkflow()?.nodes[0];
      expect(reset?.state).toBe('idle');
      expect(reset?.errorMessage).toBeUndefined();
    });
  });

  describe('backend messages', () => {
    // They are translated where they are shown: translations may not be loaded when an event
    // arrives, and the language can change afterwards.
    const KEY_ERROR = '{"key":"backendErrors.workflow.jobStopped","params":{"id":"7"}}';
    const KEY_TITLE = 'backendErrors.workflow.startingWorkflow';
    const KEY_MESSAGE =
      '{"key":"backendErrors.workflow.completedSuccessfully","params":{"name":"Backup"}}';

    it('keeps the error of a node as the backend sent it', () => {
      const { workflow, node: n } = loadWorkflowWithNode();
      executionState.next(execution(workflow.id, 'started'));

      nodeState.next(node(workflow.id, n.id, 'failed', { errorMessage: KEY_ERROR }));

      expect(stateService.currentWorkflow()?.nodes[0].errorMessage).toBe(KEY_ERROR);
    });

    it('keeps plain error text from rclone untouched', () => {
      const { workflow, node: n } = loadWorkflowWithNode();
      executionState.next(execution(workflow.id, 'started'));

      nodeState.next(
        node(workflow.id, n.id, 'failed', { errorMessage: 'Failed to copy: disk full' })
      );

      expect(stateService.currentWorkflow()?.nodes[0].errorMessage).toBe(
        'Failed to copy: disk full'
      );
    });

    it('keeps the progress title and the run message as the backend sent them', () => {
      executionState.next(execution('wf-1', 'started'));
      executionState.next(
        execution('wf-1', 'completed', {
          progress: { total: 1, completed: 1, currentStepTitle: KEY_TITLE },
          message: KEY_MESSAGE,
        })
      );

      expect(engineService.runView('wf-1')).toMatchObject({
        message: KEY_MESSAGE,
        progress: { currentStepTitle: KEY_TITLE },
      });
    });
  });

  describe('catching up from the backend', () => {
    it('shows a run that began before the interface did, as the backend has it', async () => {
      loadWorkflowWithNode();
      setup([
        snapshot('wf-events', {
          dryRun: true,
          seq: 4,
          progress: { total: 3, completed: 1, currentStepTitle: 'Copy' },
          nodes: {
            n1: { state: 'success', durationMs: 30, output: { files: 2 } },
          },
        }),
      ]);
      stateService.loadWorkflow({
        id: 'wf-events',
        name: 'Events',
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
            outputs: [],
            config: {},
          },
        ],
        edges: [],
      });
      await flush();

      expect(invoke).toHaveBeenCalledWith('get_workflow_runs', undefined);
      expect(engineService.isExecuting()).toBe(true);
      expect(engineService.isDryRun()).toBe(true);
      expect(engineService.executionProgress()?.completed).toBe(1);
      const shown = stateService.currentWorkflow()?.nodes[0];
      expect(shown?.state).toBe('success');
      expect(shown?.lastDurationMs).toBe(30);
      expect(shown?.lastOutput).toEqual({ files: 2 });
    });

    it('rebuilds the order of the steps and the end message from the events the backend kept', async () => {
      setup([
        snapshot('wf-1', {
          runId: 'run-9',
          seq: 3,
          events: [
            {
              kind: 'execution',
              workflowId: 'wf-1',
              runId: 'run-9',
              seq: 1,
              at: '2026-01-01T00:00:00.000Z',
              state: 'started',
              dryRun: false,
              message: 'Started',
            },
            {
              kind: 'node',
              workflowId: 'wf-1',
              runId: 'run-9',
              seq: 3,
              at: '2026-01-01T00:00:02.000Z',
              nodeId: 'x',
              state: 'running',
            },
          ],
        }),
      ]);
      await flush();

      expect(engineService.runView('wf-1')).toMatchObject({ steps: ['x'], message: 'Started' });
    });

    it('ends a run the interface thought was live when the backend says it ended', async () => {
      setup([]);
      await flush();
      executionState.next(execution('wf-1', 'started', { runId: 'run-1' }));
      expect(engineService.isRunning('wf-1')).toBe(true);

      invoke.mockResolvedValueOnce([
        snapshot('wf-1', { runId: 'run-1', state: 'completed', seq: 9 }),
      ]);
      serverConnected.next();
      await flush();

      expect(engineService.isRunning('wf-1')).toBe(false);
    });

    it('forgets a run the backend no longer has', async () => {
      setup([]);
      await flush();
      executionState.next(execution('wf-1', 'started'));
      invoke.mockResolvedValueOnce([]);

      engineReady.next();
      await flush();

      expect(engineService.runView('wf-1')).toBeUndefined();
    });

    it('does not take a snapshot over a later event of the same run', async () => {
      let answer!: (runs: WorkflowRunSnapshot[]) => void;
      setup(new Promise<WorkflowRunSnapshot[]>(resolve => (answer = resolve)));

      const started = execution('wf-1', 'started');
      executionState.next(started);
      executionState.next(execution('wf-1', 'completed'));
      answer([snapshot('wf-1', { runId: started.runId, seq: started.seq, state: 'started' })]);
      await flush();

      expect(engineService.isRunning('wf-1')).toBe(false);
    });

    it('does not drop a run that began while the answer was on its way', async () => {
      let answer!: (runs: WorkflowRunSnapshot[]) => void;
      setup(new Promise<WorkflowRunSnapshot[]>(resolve => (answer = resolve)));

      executionState.next(execution('wf-1', 'started'));
      answer([]);
      await flush();

      expect(engineService.isRunning('wf-1')).toBe(true);
    });

    it('asks again when the engine restarts, the backend changes or the connection returns', async () => {
      setup([]);
      await flush();
      invoke.mockClear();

      engineReady.next();
      await flush();
      backendSwitched.next('Remote');
      await flush();
      serverConnected.next();
      await flush();

      expect(invoke).toHaveBeenCalledTimes(3);
    });

    it('keeps working when the lookup fails', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      setup();
      invoke.mockRejectedValueOnce(new Error('offline'));

      engineReady.next();
      await flush();

      expect(engineService.isRunning('wf-1')).toBe(false);
      error.mockRestore();
    });

    it('stays idle when nothing has run or the answer is empty', async () => {
      for (const answer of [[], null]) {
        setup(answer);
        await flush();
        expect(engineService.isRunning('wf-1')).toBe(false);
      }
    });
  });
});
