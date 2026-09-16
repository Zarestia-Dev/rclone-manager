import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WorkflowStateService } from './workflow-state.service';

describe('WorkflowStateService', () => {
  let service: WorkflowStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [WorkflowStateService],
    });
    service = TestBed.inject(WorkflowStateService);
  });

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
      service.updateNodePosition(node.id, 200, 250);
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
});
