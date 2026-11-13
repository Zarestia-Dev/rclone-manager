import type { WorkflowDefinition } from '../../flow/workflow/types/workflow.types';
import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { WorkflowStateService } from './workflow-state.service';

describe('WorkflowStateService', () => {
  let service: WorkflowStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideTranslateService(), WorkflowStateService],
    });
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', {
      flow: { workflow: { copyName: '{{name}} (Copy)', untitled: 'Untitled Workflow' } },
    });
    translate.use('en');
    service = TestBed.inject(WorkflowStateService);
  });

  const openWorkflow = (): WorkflowDefinition => {
    const workflow = service.currentWorkflow();
    if (!workflow) throw new Error('No workflow on the canvas');
    return workflow;
  };

  it('initializes with default null workflow', () => {
    expect(service.currentWorkflow()).toBeNull();
    expect(service.viewport()).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('creates a new workflow with empty nodes', () => {
    const wf = service.createNewWorkflow('Test Flow');
    expect(wf.name).toBe('Test Flow');
    expect(service.currentWorkflow()?.name).toBe('Test Flow');
    expect(service.currentWorkflow()?.nodes.length).toBe(0);
  });

  it('adds and selects a new node with snap to grid', () => {
    service.createNewWorkflow();
    const node = service.addNode('sync', 'task', 'My Sync', 103, 205);

    expect(node.title).toBe('My Sync');
    expect(node.x).toBe(96); // snapped to multiple of 16
    expect(node.y).toBe(208); // snapped to multiple of 16
    expect(service.selectedNodeIds().has(node.id)).toBe(true);
    expect(service.selectedNode()?.id).toBe(node.id);
  });

  it('connects ports between two nodes and records undo snapshot', () => {
    service.createNewWorkflow();
    const n1 = service.addNode('manual', 'trigger', 'Trigger', 0, 0);
    const n2 = service.addNode('sync', 'task', 'Sync', 300, 0);

    const connected = service.connectPorts(n1.id, 'out', n2.id, 'in');
    expect(connected).toBe(true);
    expect(service.currentWorkflow()?.edges.length).toBe(1);

    expect(service.canUndo()).toBe(true);
    service.undo();
    expect(service.currentWorkflow()?.edges.length).toBe(0);
    service.redo();
    expect(service.currentWorkflow()?.edges.length).toBe(1);
  });

  it('duplicates a node with updated title and position offset', () => {
    service.createNewWorkflow();
    const node = service.addNode('sync', 'task', 'Sync 1', 100, 100);
    const copy = service.duplicateNode(node.id);

    expect(copy).not.toBeNull();
    expect(copy?.title).toBe('Sync 1 (Copy)');
    expect(copy?.x).toBe(node.x + 32);
    expect(service.currentWorkflow()?.nodes.length).toBe(2); // 1 added + 1 copy
  });

  it('removes node and cascade-deletes attached edges', () => {
    service.createNewWorkflow();
    const n1 = service.addNode('manual', 'trigger', 'Trigger', 0, 0);
    const n2 = service.addNode('sync', 'task', 'Sync', 300, 0);
    service.connectPorts(n1.id, 'out', n2.id, 'in');

    expect(service.currentWorkflow()?.edges.length).toBe(1);
    service.removeNode(n2.id);

    expect(service.currentWorkflow()?.nodes.some(n => n.id === n2.id)).toBe(false);
    expect(service.currentWorkflow()?.edges.length).toBe(0);
  });

  it('removes nested config fields via removeConfigField', () => {
    service.createNewWorkflow();
    const node = service.addNode('sync', 'task', 'Sync Node', 100, 100, {
      config: {
        options: { transfers: 4, checkers: 8 },
        filter_options: { exclude: '*.bak' },
      },
    });

    service.removeConfigField(node.id, 'options.transfers');
    let updated = service.currentWorkflow()?.nodes.find(n => n.id === node.id);
    expect(updated?.config['options']).toEqual({ checkers: 8 });

    service.removeConfigField(node.id, 'filter_options.exclude');
    updated = service.currentWorkflow()?.nodes.find(n => n.id === node.id);
    expect(updated?.config['filter_options']).toEqual({});
  });

  it('handles zoom and pan operations correctly', () => {
    service.setPan(150, 200);
    expect(service.viewport().x).toBe(150);
    expect(service.viewport().y).toBe(200);

    service.setZoom(1.5);
    expect(service.viewport().zoom).toBe(1.5);

    service.zoomIn();
    expect(service.viewport().zoom).toBeCloseTo(1.8, 1);

    service.resetZoom();
    expect(service.viewport()).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('adds and removes join input ports with edge cascade and minimum 2 limit', () => {
    service.createNewWorkflow();
    const joinNode = service.addNode('join', 'logic', 'Join Branches', 200, 200);
    // Initially join has 2 inputs: in1 and in2
    expect(joinNode.inputs.length).toBe(2);

    // 1. Add 3rd port
    service.addJoinInputPort(joinNode.id);
    let updated = service.currentWorkflow()?.nodes.find(n => n.id === joinNode.id);
    expect(updated?.inputs.length).toBe(3);
    expect(updated?.inputs[2].id).toBe('in3');

    // 2. Connect port in3
    const syncNode = service.addNode('sync', 'task', 'Sync', 0, 0);
    service.connectPorts(syncNode.id, 'out', joinNode.id, 'in3');
    expect(service.currentWorkflow()?.edges.length).toBe(1);

    // 3. Remove port in3 -> should remove port and cascade delete its edge
    service.removeJoinInputPort(joinNode.id, 'in3');
    updated = service.currentWorkflow()?.nodes.find(n => n.id === joinNode.id);
    expect(updated?.inputs.length).toBe(2);
    expect(service.currentWorkflow()?.edges.length).toBe(0);

    // 4. Try to remove when at minimum (2 inputs) -> should NOT remove
    service.removeJoinInputPort(joinNode.id);
    updated = service.currentWorkflow()?.nodes.find(n => n.id === joinNode.id);
    expect(updated?.inputs.length).toBe(2);
  });

  it('adds and removes fork output ports with edge cascade and minimum 2 limit', () => {
    service.createNewWorkflow();
    const forkNode = service.addNode('parallel_fork', 'logic', 'Parallel Split', 200, 200);
    // Initially parallel_fork has 2 outputs: branch1 and branch2
    expect(forkNode.outputs.length).toBe(2);

    // 1. Add 3rd port
    service.addForkOutputPort(forkNode.id);
    let updated = service.currentWorkflow()?.nodes.find(n => n.id === forkNode.id);
    expect(updated?.outputs.length).toBe(3);
    expect(updated?.outputs[2].id).toBe('branch3');
    expect(updated?.outputs[2].label).toBe('Branch 3');
    expect(updated?.outputs[2].type).toBe('out');

    // 2. Connect port branch3
    const syncNode = service.addNode('sync', 'task', 'Sync', 400, 200);
    service.connectPorts(forkNode.id, 'branch3', syncNode.id, 'in');
    expect(service.currentWorkflow()?.edges.length).toBe(1);

    // 3. Remove port branch3 -> should remove port and cascade delete its outgoing edge
    service.removeForkOutputPort(forkNode.id, 'branch3');
    updated = service.currentWorkflow()?.nodes.find(n => n.id === forkNode.id);
    expect(updated?.outputs.length).toBe(2);
    expect(service.currentWorkflow()?.edges.length).toBe(0);

    // 4. Try to remove when at minimum (2 outputs) -> should NOT remove
    service.removeForkOutputPort(forkNode.id);
    updated = service.currentWorkflow()?.nodes.find(n => n.id === forkNode.id);
    expect(updated?.outputs.length).toBe(2);
  });

  describe('dirty state / unsaved changes tracking', () => {
    it('initializes clean on workflow load and detects unsaved changes on modifications', () => {
      service.createNewWorkflow('Original Flow');
      expect(service.hasUnsavedChanges()).toBe(false);

      // 1. Adding a node makes it dirty
      const node = service.addNode('sync', 'task', 'Sync', 100, 100);
      expect(service.hasUnsavedChanges()).toBe(true);

      // 2. markSaved resets dirty state
      service.markSaved();
      expect(service.hasUnsavedChanges()).toBe(false);

      // 3. Moving a node makes it dirty again
      service.updateNodesPositions(new Map([[node.id, { x: 200, y: 250 }]]));
      expect(service.hasUnsavedChanges()).toBe(true);

      // 4. Updating workflow metadata makes it dirty
      service.markSaved();
      service.setWorkflowName('Renamed Flow');
      expect(service.hasUnsavedChanges()).toBe(true);
    });

    it('reverts hasUnsavedChanges to false when user undoes back to baseline saved state', () => {
      service.createNewWorkflow('Base Flow');
      expect(service.hasUnsavedChanges()).toBe(false);

      service.addNode('sync', 'task', 'Sync Task', 100, 100);
      expect(service.hasUnsavedChanges()).toBe(true);

      // Undo the addition
      service.undo();
      expect(service.hasUnsavedChanges()).toBe(false);

      // Redo restores dirty state
      service.redo();
      expect(service.hasUnsavedChanges()).toBe(true);
    });

    it('ignores transient execution states in content hash comparison', () => {
      service.createNewWorkflow('Exec Flow');
      expect(service.hasUnsavedChanges()).toBe(false);

      // Transient node state changes (like during execution engine runs)
      service.currentWorkflow.update(current => {
        if (!current) return null;
        return {
          ...current,
          nodes: current.nodes.map(n => ({
            ...n,
            state: 'running' as const,
            errorMessage: 'transient err',
            lastDurationMs: 123,
          })),
        };
      });

      // Still clean because persistent structure hasn't changed!
      expect(service.hasUnsavedChanges()).toBe(false);
    });

    it('does not mark hasUnsavedChanges as true when isDraggingNode is active without workflow modifications', () => {
      service.createNewWorkflow('Touch Hold Flow');
      service.markSaved();
      expect(service.hasUnsavedChanges()).toBe(false);

      // Simulating touch start / hold without position change
      service.isDraggingNode.set(true);
      expect(service.hasUnsavedChanges()).toBe(false);

      service.isDraggingNode.set(false);
      expect(service.hasUnsavedChanges()).toBe(false);
    });
  });

  describe('multi-node positioning and bidirectional connections', () => {
    it('updates multiple node positions atomically with updateNodesPositions', () => {
      service.createNewWorkflow();
      const n1 = service.addNode('sync', 'task', 'Node 1', 100, 100);
      const n2 = service.addNode('copy', 'task', 'Node 2', 200, 200);

      const updates = new Map([
        [n1.id, { x: 150, y: 160 }],
        [n2.id, { x: 250, y: 260 }],
      ]);
      service.updateNodesPositions(updates);

      const wf = service.currentWorkflow();
      const updated1 = wf?.nodes.find(n => n.id === n1.id);
      const updated2 = wf?.nodes.find(n => n.id === n2.id);

      expect(updated1?.x).toBe(144);
      expect(updated1?.y).toBe(160);
      expect(updated2?.x).toBe(256);
      expect(updated2?.y).toBe(256);
    });

    it('completes reverse connection from input to output properly', () => {
      service.createNewWorkflow();
      const sourceTask = service.addNode('sync', 'task', 'Source', 0, 0);
      const destTask = service.addNode('notification', 'action', 'Dest', 300, 0);

      // Start drag from destTask input port: isSourceOutput = false
      service.startConnecting(destTask.id, 'in', 300, 0, false);
      expect(service.isConnecting()).toEqual(
        expect.objectContaining({ sourceNodeId: destTask.id, isSourceOutput: false })
      );

      // Drop onto sourceTask output port: isTargetOutput = true
      const success = service.finishConnecting(sourceTask.id, 'out', true);
      expect(success).toBe(true);

      const wf = service.currentWorkflow();
      expect(wf?.edges.length).toBe(1);
      expect(wf?.edges[0].sourceNodeId).toBe(sourceTask.id);
      expect(wf?.edges[0].targetNodeId).toBe(destTask.id);
    });

    it('uses dynamic canvasDimensions in fitToView', () => {
      service.createNewWorkflow();
      service.canvasDimensions.set({ width: 1200, height: 800 });
      service.addNode('sync', 'task', 'Node 1', 200, 200);

      service.fitToView();
      expect(service.viewport().zoom).toBeGreaterThan(0);
      expect(service.viewport().x).toBeDefined();
    });

    it('manages and resets mobile UI state signals', () => {
      expect(service.isWorkspaceDrawerOpen()).toBe(false);
      expect(service.isMobileFocusMode()).toBe(false);

      service.isWorkspaceDrawerOpen.set(true);
      service.isMobileFocusMode.set(true);
      expect(service.isWorkspaceDrawerOpen()).toBe(true);
      expect(service.isMobileFocusMode()).toBe(true);

      service.resetMobileUiState();
      expect(service.isWorkspaceDrawerOpen()).toBe(false);
      expect(service.isMobileFocusMode()).toBe(false);
    });
  });
  describe('editing history', () => {
    it('joins quick edits of the same field into one undo step', () => {
      service.createNewWorkflow();
      const node = service.addNode('delay', 'logic', 'Wait', 0, 0);

      for (const value of ['1', '12', '123']) {
        service.updateNodeConfig(node.id, { delaySeconds: value });
      }
      expect(service.currentWorkflow()?.nodes[0].config['delaySeconds']).toBe('123');

      service.undo();
      expect(service.currentWorkflow()?.nodes[0].config['delaySeconds']).toBeUndefined();
    });

    it('keeps edits of different fields as separate steps', () => {
      service.createNewWorkflow();
      const node = service.addNode('delay', 'logic', 'Wait', 0, 0);

      service.updateNodeConfig(node.id, { delaySeconds: 5 });
      service.updateNodeConfig(node.id, { label: 'x' });
      service.undo();

      expect(service.currentWorkflow()?.nodes[0].config).toEqual({ delaySeconds: 5 });
    });

    it('keeps the results of a run on the nodes when stepping through history', () => {
      service.createNewWorkflow();
      const node = service.addNode('delay', 'logic', 'Wait', 0, 0);
      service.updateNodeConfig(node.id, { delaySeconds: 5 });
      service.recordNodeRun(openWorkflow().id, node.id, 'success', undefined, 40, {
        waited: 5,
      });

      service.undo();

      const restored = service.currentWorkflow()?.nodes[0];
      expect(restored?.config['delaySeconds']).toBeUndefined();
      expect(restored?.state).toBe('success');
      expect(restored?.lastOutput).toEqual({ waited: 5 });
    });

    it('does not keep the results of a run in the history', () => {
      service.createNewWorkflow();
      const node = service.addNode('delay', 'logic', 'Wait', 0, 0);
      service.recordNodeRun(openWorkflow().id, node.id, 'success', undefined, 40, {
        big: 'x'.repeat(100),
      });
      service.updateNodeConfig(node.id, { delaySeconds: 5 });

      const stack = (service as unknown as { undoStack: { nodes: object[] }[] }).undoStack;
      expect(JSON.stringify(stack)).not.toContain('xxxx');
    });
  });

  describe('join and fork branches', () => {
    it('adds a branch as an undo step and takes it back with undo', () => {
      service.createNewWorkflow();
      const join = service.addNode('join', 'logic', 'Join', 0, 0);
      expect(service.currentWorkflow()?.nodes[0].inputs.length).toBe(2);

      service.addJoinInputPort(join.id);
      expect(service.currentWorkflow()?.nodes[0].inputs.map(p => p.id)).toEqual([
        'in1',
        'in2',
        'in3',
      ]);
      service.undo();
      expect(service.currentWorkflow()?.nodes[0].inputs.length).toBe(2);
    });

    it('keeps at least two branches, and a refused removal is not an undo step', () => {
      service.createNewWorkflow();
      const fork = service.addNode('parallel_fork', 'logic', 'Fork', 0, 0);
      service.markSaved();
      const stepsBefore = (service as unknown as { undoStack: unknown[] }).undoStack.length;

      service.removeForkOutputPort(fork.id);

      expect(service.currentWorkflow()?.nodes[0].outputs.length).toBe(2);
      expect((service as unknown as { undoStack: unknown[] }).undoStack.length).toBe(stepsBefore);
      expect(service.hasUnsavedChanges()).toBe(false);
    });

    it('removes a branch with the wires on it', () => {
      service.createNewWorkflow();
      const fork = service.addNode('parallel_fork', 'logic', 'Fork', 0, 0);
      const sink = service.addNode('notification', 'action', 'Sink', 300, 0);
      service.addForkOutputPort(fork.id);
      service.connectPorts(fork.id, 'branch3', sink.id, 'in');

      service.removeForkOutputPort(fork.id, 'branch3');

      expect(service.currentWorkflow()?.nodes[0].outputs.length).toBe(2);
      expect(service.currentWorkflow()?.edges).toEqual([]);
    });
  });

  describe('wiring', () => {
    it('refuses a wire that would close a loop', () => {
      service.createNewWorkflow();
      const a = service.addNode('sync', 'task', 'A', 0, 0);
      const b = service.addNode('sync', 'task', 'B', 200, 0);
      const c = service.addNode('sync', 'task', 'C', 400, 0);

      expect(service.connectPorts(a.id, 'success', b.id, 'in')).toBe(true);
      expect(service.connectPorts(b.id, 'success', c.id, 'in')).toBe(true);
      expect(service.connectPorts(c.id, 'success', a.id, 'in')).toBe(false);
      expect(service.currentWorkflow()?.edges.length).toBe(2);
    });
  });

  describe('ports', () => {
    it('numbers added ports past any existing id and keeps their label translatable', () => {
      service.createNewWorkflow();
      const join = service.addNode('join', 'logic', 'Join', 0, 0);
      service.addJoinInputPort(join.id);
      service.addJoinInputPort(join.id);
      service.removeJoinInputPort(join.id, 'in3');
      service.addJoinInputPort(join.id);

      const ports = service.currentWorkflow()?.nodes[0].inputs ?? [];
      expect(ports.map(p => p.id)).toEqual(['in1', 'in2', 'in4', 'in5']);
      expect(ports[3].labelKey).toBe('flow.workflow.ports.inN');
      expect(ports[3].labelParams).toEqual({ n: 5 });
    });
  });

  describe('dirty state while dragging', () => {
    it('reports changes without hashing the workflow while a node is dragged', () => {
      service.createNewWorkflow();
      const node = service.addNode('sync', 'task', 'A', 0, 0);
      service.markSaved();
      expect(service.hasUnsavedChanges()).toBe(false);

      service.snapshot();
      service.isDraggingNode.set(true);
      service.updateNodesPositions(new Map([[node.id, { x: 0, y: 0 }]]));
      expect(service.hasUnsavedChanges()).toBe(true);
    });
  });

  describe('unsaved changes', () => {
    it('stays clean after undo back to the saved state', () => {
      service.createNewWorkflow();
      service.addNode('manual', 'trigger', 'A', 0, 0);
      service.markSaved();
      service.addNode('sync', 'task', 'B', 300, 0);
      expect(service.hasUnsavedChanges()).toBe(true);

      service.undo();
      expect(service.hasUnsavedChanges()).toBe(false);
      service.redo();
      expect(service.hasUnsavedChanges()).toBe(true);
    });

    it('sees new edits after undoing past the saved state as unsaved, however many there are', () => {
      service.createNewWorkflow();
      service.addNode('manual', 'trigger', 'A', 0, 0);
      service.addNode('sync', 'task', 'B', 300, 0);
      service.markSaved();
      service.undo();
      service.undo();

      service.addNode('copy', 'task', 'C', 0, 0);
      service.addNode('move', 'task', 'D', 300, 0);

      expect(service.hasUnsavedChanges()).toBe(true);
    });

    it('is not changed by what a run leaves on the nodes', () => {
      const wf = service.createNewWorkflow();
      const node = service.addNode('manual', 'trigger', 'A', 0, 0);
      service.markSaved();
      service.recordNodeRun(wf.id, node.id, 'running');
      service.recordNodeRun(wf.id, node.id, 'success', undefined, 5, { ok: true });

      expect(service.hasUnsavedChanges()).toBe(false);
    });

    it('is false with no workflow', () => {
      expect(service.hasUnsavedChanges()).toBe(false);
    });
  });

  describe('tray flag', () => {
    it('is not an undo step and is not changed by undo', () => {
      service.createNewWorkflow();
      service.addNode('manual', 'trigger', 'A', 0, 0);
      service.markSaved();

      service.setShowOnTray(true);
      expect(service.hasUnsavedChanges()).toBe(false);

      service.addNode('sync', 'task', 'B', 300, 0);
      service.undo();
      expect(service.currentWorkflow()?.showOnTray).toBe(true);
      service.undo();
      expect(service.currentWorkflow()?.showOnTray).toBe(true);
      expect(service.canUndo()).toBe(false);
    });
  });

  describe('new nodes', () => {
    it('own their settings and ports instead of sharing the ones they were made from', () => {
      service.createNewWorkflow();
      const config = { nested: { a: 1 } };
      const ports = [{ id: 'in', name: 'In', type: 'in' as const }];
      const first = service.addNode('x', 'task', 'X', 0, 0, { config, inputs: ports });
      const second = service.addNode('x', 'task', 'Y', 100, 0, { config, inputs: ports });

      expect(first.config).toEqual(config);
      expect(first.config).not.toBe(config);
      expect(first.config).not.toBe(second.config);
      expect(first.inputs).not.toBe(ports);
    });
  });

  describe('run results', () => {
    it('are kept for a workflow that is not on the canvas and shown when it is opened again', () => {
      const first = service.createNewWorkflow('First');
      const node = service.addNode('manual', 'trigger', 'A', 0, 0);
      const stored = structuredClone(openWorkflow());
      service.markSaved();

      const second = service.createNewWorkflow('Second');
      service.recordNodeRun(first.id, node.id, 'failed', 'boom', 12, { why: 'x' });
      expect(service.currentWorkflow()?.id).toBe(second.id);
      expect(service.currentWorkflow()?.nodes.length).toBe(0);

      service.loadWorkflow(stored);
      const shown = service.currentWorkflow()?.nodes[0];
      expect(shown?.state).toBe('failed');
      expect(shown?.errorMessage).toBe('boom');
      expect(shown?.lastDurationMs).toBe(12);
      expect(shown?.lastOutput).toEqual({ why: 'x' });
      expect(service.hasUnsavedChanges()).toBe(false);
    });

    it('reset to idle for the next run but keep the output for the token pickers', () => {
      const wf = service.createNewWorkflow();
      const node = service.addNode('manual', 'trigger', 'A', 0, 0);
      service.recordNodeRun(wf.id, node.id, 'failed', 'boom', 12, { why: 'x' });

      service.resetRunResults(wf.id);

      const reset = service.currentWorkflow()?.nodes[0];
      expect(reset?.state).toBe('idle');
      expect(reset?.errorMessage).toBeUndefined();
      expect(reset?.lastDurationMs).toBeUndefined();
      expect(reset?.lastOutput).toEqual({ why: 'x' });

      service.loadWorkflow({ ...openWorkflow(), nodes: [{ ...node }] });
      expect(service.currentWorkflow()?.nodes[0].state).toBe('idle');
    });
  });

  describe('saving', () => {
    it('stores the view the user left the canvas in', () => {
      service.createNewWorkflow();
      service.setPan(120, -40);
      service.setZoom(1.5);

      expect(service.workflowToStore()?.viewport).toEqual(service.viewport());
      expect(service.currentWorkflowId()).toBe(service.currentWorkflow()?.id);
    });

    it('has nothing to store without a workflow', () => {
      expect(service.workflowToStore()).toBeNull();
      expect(service.currentWorkflowId()).toBeUndefined();
    });
  });

  describe('edit version', () => {
    it('changes with edits and with the workflow opened, not with run results', () => {
      const wf = service.createNewWorkflow();
      const opened = service.editVersion();

      const node = service.addNode('manual', 'trigger', 'A', 0, 0);
      const edited = service.editVersion();
      expect(edited).not.toBe(opened);

      service.recordNodeRun(wf.id, node.id, 'success');
      expect(service.editVersion()).toBe(edited);

      service.createNewWorkflow();
      expect(service.editVersion()).not.toBe(edited);
    });
  });

  describe('forgetting run results', () => {
    it('drops the results of a workflow, so it opens clean again', () => {
      const wf = service.createNewWorkflow();
      const node = service.addNode('sync', 'task', 'A', 0, 0);
      service.markSaved();
      // what is stored carries no results of a run
      const stored = structuredClone(service.currentWorkflow() as WorkflowDefinition);
      service.recordNodeRun(wf.id, node.id, 'failed', 'boom', 5, { out: 1 });

      service.forgetRunResults(wf.id);
      service.loadWorkflow(stored);

      const reopened = service.currentWorkflow()?.nodes[0];
      expect(reopened?.errorMessage).toBeUndefined();
      expect(reopened?.lastOutput).toBeUndefined();
    });
  });
});
