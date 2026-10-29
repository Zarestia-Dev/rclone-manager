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

  let invoke: ReturnType<typeof vi.fn>;
  let engineReady: Subject<void>;
  let backendSwitched: Subject<string>;
  let executionState: Subject<WorkflowExecutionStatePayload>;

  function setup(activeWorkflows: Promise<string[] | null> | string[] | null = null): void {
    TestBed.resetTestingModule();
    invoke = vi
      .fn()
      .mockImplementation((command: string) =>
        command === 'get_active_workflows'
          ? Promise.resolve(activeWorkflows)
          : Promise.resolve(null)
      );
    engineReady = new Subject<void>();
    backendSwitched = new Subject<string>();
    executionState = new Subject<WorkflowExecutionStatePayload>();
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
            listenToWorkflowNodeStateChanged: vi.fn().mockReturnValue(new Subject()),
            listenToWorkflowExecutionStateChanged: vi.fn().mockReturnValue(executionState),
            listenToRcloneEngineReady: vi.fn().mockReturnValue(engineReady),
            listenToBackendSwitched: vi.fn().mockReturnValue(backendSwitched),
          },
        },
      ],
    });

    stateService = TestBed.inject(WorkflowStateService);
    engineService = TestBed.inject(WorkflowEngineService);
    service = TestBed.inject(WorkflowEventService);
  }

  beforeEach(() => setup());

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

  describe('active workflow hydration', () => {
    const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve));

    it('shows a run that began before the service existed', async () => {
      setup(['wf-autostart']);
      await flush();

      expect(invoke).toHaveBeenCalledWith('get_active_workflows', undefined);
      expect(engineService.isExecuting()).toBe(true);
    });

    it('stays idle when nothing is running or the answer is empty', async () => {
      for (const answer of [[], null]) {
        setup(answer);
        await flush();
        expect(engineService.isExecuting()).toBe(false);
      }
    });

    it('does not clear a run the interface started itself', async () => {
      setup([]);
      await flush();
      engineService.isExecuting.set(true);

      engineReady.next();
      await flush();

      expect(engineService.isExecuting()).toBe(true);
    });

    it('asks again when the engine restarts or the backend changes', async () => {
      setup([]);
      await flush();
      invoke.mockClear();

      engineReady.next();
      backendSwitched.next('Remote');
      await flush();

      expect(invoke).toHaveBeenCalledTimes(2);
    });

    it('lets a newer completion event win over a slower answer', async () => {
      let answer!: (ids: string[]) => void;
      setup(new Promise<string[]>(resolve => (answer = resolve)));

      executionState.next({ workflowId: 'wf-1', state: 'completed' });
      answer(['wf-1']);
      await flush();

      expect(engineService.isExecuting()).toBe(false);
    });

    it('keeps working when the lookup fails', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      setup();
      invoke.mockRejectedValueOnce(new Error('offline'));

      engineReady.next();
      await flush();

      expect(engineService.isExecuting()).toBe(false);
      error.mockRestore();
    });
  });
});
