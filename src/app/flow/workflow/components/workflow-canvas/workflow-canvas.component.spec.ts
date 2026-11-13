import type { WorkflowDefinition, WorkflowNode } from '../../types/workflow.types';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WorkflowCanvasComponent } from './workflow-canvas.component';
import { WorkflowStateService } from '../../../../services/flow/workflow-state.service';
import { WorkflowEngineService } from '../../../../services/flow/workflow-engine.service';
import { WorkflowDragDropService } from '../../../../services/flow/workflow-drag-drop.service';
import { ModalService } from '../../../../services/ui/modal.service';
import {
  WorkflowNodeLayoutService,
  portKey,
} from '../../../../services/flow/workflow-node-layout.service';
import { provideTranslateService } from '@ngx-translate/core';

interface PointerInit {
  clientX?: number;
  clientY?: number;
  pointerId?: number;
  pointerType?: string;
  button?: number;
  shiftKey?: boolean;
}

/** Gives a node the layout a browser would measure: 240 wide, its ports on the left and right edges. */
function measureNode(layout: WorkflowNodeLayoutService, node: WorkflowNode): void {
  const ports: Record<string, { x: number; y: number }> = {};
  node.inputs.forEach((p, i) => (ports[portKey(p.id, false)] = { x: 0, y: 97 + i * 28 }));
  node.outputs.forEach((p, i) => (ports[portKey(p.id, true)] = { x: 240, y: 97 + i * 28 }));
  layout.set(node.id, { width: 240, height: 140, ports });
}

/** A pointer event; built on MouseEvent so it does not depend on the test DOM's PointerEvent. */
function firePointer(target: EventTarget, type: string, init: PointerInit = {}): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    button: init.button ?? 0,
    shiftKey: init.shiftKey ?? false,
  });
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId ?? 1 },
    pointerType: { value: init.pointerType ?? 'mouse' },
  });
  target.dispatchEvent(event);
  return event;
}

describe('WorkflowCanvasComponent', () => {
  let fixture: ComponentFixture<WorkflowCanvasComponent>;
  let component: WorkflowCanvasComponent;
  let stateService: WorkflowStateService;
  let dragDropService: WorkflowDragDropService;
  let layoutService: WorkflowNodeLayoutService;
  let modalServiceSpy: { openWorkflowNodeEditor: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    modalServiceSpy = { openWorkflowNodeEditor: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [WorkflowCanvasComponent],
      providers: [
        provideTranslateService(),
        WorkflowStateService,
        WorkflowDragDropService,
        {
          provide: WorkflowEngineService,
          useValue: { activeEdgeIds: (): Set<string> => new Set() },
        },
        {
          provide: ModalService,
          useValue: modalServiceSpy,
        },
      ],
    }).compileComponents();

    stateService = TestBed.inject(WorkflowStateService);
    dragDropService = TestBed.inject(WorkflowDragDropService);
    layoutService = TestBed.inject(WorkflowNodeLayoutService);
    stateService.createNewWorkflow('Canvas Test');
    stateService.addNode('manual', 'trigger', 'Trigger', 100, 100);

    fixture = TestBed.createComponent(WorkflowCanvasComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders canvas with active workflow nodes', () => {
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.workflow-canvas-container')).toBeTruthy();
    expect(el.querySelectorAll('.workflow-node-positioned').length).toBe(1);
  });

  it('computes valid canvas transform string', () => {
    expect(component.canvasTransform()).toContain('translate(0px, 0px) scale(1)');
  });

  it('opens workflow node editor modal on inspectNode for operation node', () => {
    const syncNode = stateService.addNode('sync', 'task', 'Sync Step', 200, 200, {});
    component.onInspectNode(syncNode.id);
    expect(modalServiceSpy.openWorkflowNodeEditor).toHaveBeenCalledWith(
      expect.objectContaining({ id: syncNode.id, type: 'sync' })
    );
  });

  it('selects node on inspectNode for non-operation node', () => {
    const delayNode = stateService.addNode('delay', 'logic', 'Wait', 200, 200, {});
    component.onInspectNode(delayNode.id);
    expect(stateService.selectedNode()?.id).toBe(delayNode.id);
  });

  it('deletes selected edge when Delete key is pressed', () => {
    const nodeA = stateService.addNode('sync', 'task', 'Node A', 100, 100, {});
    const nodeB = stateService.addNode('notification', 'action', 'Node B', 400, 100, {});
    stateService.connectPorts(nodeA.id, 'out', nodeB.id, 'in');

    const edge = stateService.currentWorkflow()?.edges[0];
    expect(edge).toBeTruthy();
    if (!edge) return;

    stateService.selectEdge(edge.id);
    expect(stateService.selectedEdgeIds().has(edge.id)).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
    expect(stateService.currentWorkflow()?.edges.length).toBe(0);
  });

  const openWorkflow = (): WorkflowDefinition => {
    const workflow = stateService.currentWorkflow();
    if (!workflow) throw new Error('No workflow on the canvas');
    return workflow;
  };

  const container = (): HTMLElement =>
    fixture.nativeElement.querySelector('.workflow-canvas-container');
  const nodeEl = (id: string): HTMLElement =>
    fixture.nativeElement.querySelector(`.workflow-node-positioned[data-node-id="${id}"]`);

  it.each(['mouse', 'touch'])('pans with one %s pointer on the background', pointerType => {
    const setPanSpy = vi.spyOn(stateService, 'setPan');

    firePointer(container(), 'pointerdown', { clientX: 100, clientY: 100, pointerType });
    expect(component.isPanning()).toBe(true);

    firePointer(window, 'pointermove', { clientX: 150, clientY: 120, pointerType });
    expect(setPanSpy).toHaveBeenCalledWith(50, 20);

    firePointer(window, 'pointerup', { pointerType });
    expect(component.isPanning()).toBe(false);
  });

  it('pans with the right mouse button from anywhere, even over a node', () => {
    const node = openWorkflow().nodes[0];
    firePointer(nodeEl(node.id), 'pointerdown', { button: 2 });
    expect(component.isPanning()).toBe(true);
    expect(component.draggingNodeId()).toBeNull();
    firePointer(window, 'pointerup');
  });

  it('ends a pan released over a port, which used to leave it stuck to the pointer', () => {
    firePointer(container(), 'pointerdown', { clientX: 10, clientY: 10 });
    expect(component.isPanning()).toBe(true);

    const port = fixture.nativeElement.querySelector('.port-handle') as HTMLElement;
    firePointer(port, 'pointerup', { clientX: 10, clientY: 10 });
    expect(component.isPanning()).toBe(false);
  });

  it('pinch-zooms when a second finger lands, then pans on with the remaining one', () => {
    const setZoomSpy = vi.spyOn(stateService, 'setZoom');

    firePointer(container(), 'pointerdown', {
      clientX: 100,
      clientY: 100,
      pointerId: 1,
      pointerType: 'touch',
    });
    firePointer(container(), 'pointerdown', {
      clientX: 200,
      clientY: 100,
      pointerId: 2,
      pointerType: 'touch',
    });
    // The pan the first finger began is replaced by the pinch.
    expect(component.isPanning()).toBe(false);

    firePointer(window, 'pointermove', {
      clientX: 75,
      clientY: 100,
      pointerId: 1,
      pointerType: 'touch',
    });
    firePointer(window, 'pointermove', {
      clientX: 225,
      clientY: 100,
      pointerId: 2,
      pointerType: 'touch',
    });
    expect(setZoomSpy).toHaveBeenLastCalledWith(
      expect.closeTo(1.5, 1),
      expect.any(Number),
      expect.any(Number)
    );

    // Lifting one finger carries on as a pan with the other.
    firePointer(window, 'pointerup', { pointerId: 1, pointerType: 'touch' });
    expect(component.isPanning()).toBe(true);
    firePointer(window, 'pointerup', { pointerId: 2, pointerType: 'touch' });
    expect(component.isPanning()).toBe(false);
  });

  it('zooms by how far the wheel turned', () => {
    const wheel = (deltaY: number): void => {
      container().dispatchEvent(
        new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true })
      );
    };
    wheel(-100);
    const notch = stateService.viewport().zoom;
    expect(notch).toBeGreaterThan(1.1);
    expect(notch).toBeLessThan(1.15);

    stateService.resetZoom();
    wheel(-10);
    expect(stateService.viewport().zoom).toBeLessThan(1.02);

    stateService.resetZoom();
    wheel(-5000);
    expect(stateService.viewport().zoom).toBeCloseTo(notch, 5);

    stateService.resetZoom();
    wheel(100);
    expect(stateService.viewport().zoom).toBeLessThan(0.9);
  });

  it('starts a node drag on touch and selects only that node', () => {
    const node = openWorkflow().nodes[0];
    stateService.clearSelection();
    const selectSpy = vi.spyOn(stateService, 'selectNode');

    firePointer(nodeEl(node.id), 'pointerdown', {
      clientX: 120,
      clientY: 120,
      pointerType: 'touch',
    });

    expect(component.draggingNodeId()).toBe(node.id);
    expect(selectSpy).toHaveBeenCalledWith(node.id, false);
    firePointer(window, 'pointerup', { pointerType: 'touch' });
  });

  it('applies is-drag-target class when WorkflowDragDropService.isDragging is true', () => {
    const el: HTMLElement = fixture.nativeElement;
    const container = el.querySelector('.workflow-canvas-container');
    expect(container?.classList.contains('is-drag-target')).toBe(false);

    dragDropService.beginDrag(
      {
        type: 'sync',
        category: 'task',
        titleKey: 'flow.workflow.operations.sync',
        descriptionKey: 'flow.workflow.operations.syncDesc',
        icon: 'sync',
        defaultInputs: [],
        defaultOutputs: [],
        defaultConfig: {},
      },
      { x: 10, y: 10 }
    );
    fixture.detectChanges();

    expect(container?.classList.contains('is-drag-target')).toBe(true);

    dragDropService.cancelDrag();
    fixture.detectChanges();

    expect(container?.classList.contains('is-drag-target')).toBe(false);
  });

  it('precomputes renderedWires with accurate port coordinates', () => {
    const nodeA = stateService.addNode('sync', 'task', 'Node A', 100, 100, {});
    const nodeB = stateService.addNode('notification', 'action', 'Node B', 400, 100, {});
    stateService.connectPorts(nodeA.id, 'success', nodeB.id, 'in');

    // A wire is drawn once both of its nodes have been measured.
    expect(component.renderedWires()).toEqual([]);
    measureNode(layoutService, nodeA);
    expect(component.renderedWires()).toEqual([]);
    measureNode(layoutService, nodeB);

    const wires = component.renderedWires();
    expect(wires.length).toBe(1);
    expect(wires[0].edge.sourceNodeId).toBe(nodeA.id);
    expect(wires[0].edge.targetNodeId).toBe(nodeB.id);
    expect(wires[0].sourcePos).toEqual({ x: nodeA.x + 240, y: nodeA.y + 97 });
    expect(wires[0].targetPos).toEqual({ x: nodeB.x, y: nodeB.y + 97 });
  });

  it('draws the wire to the port as measured, not to a guessed row', () => {
    const nodeA = stateService.addNode('sync', 'task', 'Node A', 100, 100, {});
    const nodeB = stateService.addNode('notification', 'action', 'Node B', 400, 100, {});
    stateService.connectPorts(nodeA.id, 'success', nodeB.id, 'in');
    measureNode(layoutService, nodeA);
    measureNode(layoutService, nodeB);
    // The target grows a taller header: its port moves down and the wire follows.
    layoutService.set(nodeB.id, {
      width: 240,
      height: 150,
      ports: { [portKey('in', false)]: { x: 0, y: 108 } },
    });
    expect(component.renderedWires()[0].targetPos).toEqual({ x: nodeB.x, y: nodeB.y + 108 });
  });

  it('computes bidirectional connecting bezier path correctly', () => {
    const nodeA = stateService.addNode('sync', 'task', 'Node A', 100, 100, {});
    measureNode(layoutService, nodeA);

    // 1. Forward connection (output to mouse)
    stateService.startConnecting(nodeA.id, 'success', 300, 200, true);
    fixture.detectChanges();
    const forwardPath = component.connectingPath();
    expect(forwardPath).toContain('M ');
    expect(forwardPath).toContain('C ');

    // 2. Reverse connection (input to mouse)
    stateService.startConnecting(nodeA.id, 'in', 50, 50, false);
    fixture.detectChanges();
    const reversePath = component.connectingPath();
    expect(reversePath).toContain('M ');
    expect(reversePath).toContain('C ');
  });

  it('draws no connecting wire from a port of a node that is not measured yet', () => {
    const nodeA = stateService.addNode('sync', 'task', 'Node A', 100, 100, {});
    stateService.startConnecting(nodeA.id, 'success', 300, 200, true);
    expect(component.connectingPath()).toBe('');
  });

  it('cancels active connecting and panning with Escape key', () => {
    const nodeA = stateService.addNode('sync', 'task', 'Node A', 100, 100, {});
    stateService.startConnecting(nodeA.id, 'out', 300, 200, true);
    expect(stateService.isConnecting()).not.toBeNull();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(stateService.isConnecting()).toBeNull();
  });

  it('drags multiple selected nodes together maintaining relative offsets and creates undo snapshot', () => {
    const nodeA = stateService.addNode('sync', 'task', 'Node A', 100, 100, {});
    const nodeB = stateService.addNode('notification', 'action', 'Node B', 300, 100, {});
    stateService.selectNode(nodeA.id, false);
    stateService.selectNode(nodeB.id, true);

    expect(stateService.selectedNodeIds().size).toBe(2);

    const containerEl = fixture.nativeElement.querySelector('.workflow-canvas-container');
    vi.spyOn(containerEl, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 700,
      right: 1000,
      bottom: 700,
    } as DOMRect);

    fixture.detectChanges();
    firePointer(nodeEl(nodeA.id), 'pointerdown', { clientX: 100, clientY: 100 });

    expect(component.draggingNodeId()).toBe(nodeA.id);

    // Pointer moves by dx=48, dy=32
    firePointer(window, 'pointermove', { clientX: 148, clientY: 132 });

    const updatedA = stateService.currentWorkflow()?.nodes.find(n => n.id === nodeA.id);
    const updatedB = stateService.currentWorkflow()?.nodes.find(n => n.id === nodeB.id);

    expect(updatedA?.x).toBeGreaterThan(100);
    expect(updatedB?.x).toBeGreaterThan(300);

    // Pointer up finishes drag
    firePointer(window, 'pointerup');
    expect(component.draggingNodeId()).toBeNull();
    expect(stateService.canUndo()).toBe(true);

    // Undo properly restores pre-drag positions (verifying fix #7)
    stateService.undo();
    const revertedA = stateService.currentWorkflow()?.nodes.find(n => n.id === nodeA.id);
    const revertedB = stateService.currentWorkflow()?.nodes.find(n => n.id === nodeB.id);
    expect(revertedA?.x).toBe(nodeA.x);
    expect(revertedB?.x).toBe(nodeB.x);
  });

  it('renders floating canvas navigation hub with zoom controls and minimap', () => {
    const el: HTMLElement = fixture.nativeElement;
    const hub = el.querySelector('.canvas-navigation-hub');
    expect(hub).toBeTruthy();
    expect(hub?.querySelector('.floating-zoom-toolbar')).toBeTruthy();
    expect(hub?.querySelector('.minimap-container')).toBeTruthy();
    expect(hub?.querySelector('.zoom-percentage')?.textContent).toContain('100%');
  });

  it('toggles minimap visibility when toggleMinimap is called', () => {
    expect(component.showMinimap()).toBe(true);
    component.toggleMinimap();
    expect(component.showMinimap()).toBe(false);

    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.minimap-container')).toBeNull();

    component.toggleMinimap();
    expect(component.showMinimap()).toBe(true);
  });

  it('delegates zoomIn, zoomOut, resetZoom, and fitToView to stateService', () => {
    const zoomInSpy = vi.spyOn(stateService, 'zoomIn');
    const zoomOutSpy = vi.spyOn(stateService, 'zoomOut');
    const resetZoomSpy = vi.spyOn(stateService, 'resetZoom');
    const fitToViewSpy = vi.spyOn(stateService, 'fitToView');

    component.zoomIn();
    expect(zoomInSpy).toHaveBeenCalled();

    component.zoomOut();
    expect(zoomOutSpy).toHaveBeenCalled();

    component.resetZoom();
    expect(resetZoomSpy).toHaveBeenCalled();

    component.fitToView();
    expect(fitToViewSpy).toHaveBeenCalled();
  });

  it('toggles mobile focus mode and clears it on destroy', () => {
    expect(stateService.isMobileFocusMode()).toBe(false);
    component.toggleFocusMode();
    expect(stateService.isMobileFocusMode()).toBe(true);
    component.ngOnDestroy();
    expect(stateService.isMobileFocusMode()).toBe(false);
  });

  describe('Wires and touch interactions', () => {
    let originalElementFromPoint: typeof document.elementFromPoint;

    beforeEach(() => {
      originalElementFromPoint = document.elementFromPoint;
      document.elementFromPoint = vi.fn().mockReturnValue(null);
    });

    afterEach(() => {
      document.elementFromPoint = originalElementFromPoint;
    });

    const portOf = (nodeId: string, portId: string): HTMLElement =>
      fixture.nativeElement.querySelector(
        `.port-handle[data-node-id="${nodeId}"][data-port-id="${portId}"]`
      );

    it('does not start a node drag from a port handle or an action button', () => {
      const node = openWorkflow().nodes[0];

      firePointer(portOf(node.id, 'out'), 'pointerdown', { pointerType: 'touch' });
      expect(component.draggingNodeId()).toBeNull();
      firePointer(window, 'pointerup', { pointerType: 'touch' });

      const button = nodeEl(node.id).querySelector('.action-button') as HTMLElement;
      firePointer(button, 'pointerdown', { pointerType: 'touch' });
      expect(component.draggingNodeId()).toBeNull();
      expect(stateService.isDraggingNode()).toBe(false);
    });

    it('starts a wire from a port handle and follows the pointer', () => {
      const node = openWorkflow().nodes[0];
      const updateSpy = vi.spyOn(stateService, 'updateConnecting');

      firePointer(portOf(node.id, 'out'), 'pointerdown', { clientX: 100, clientY: 100 });
      expect(stateService.isConnecting()).toEqual(
        expect.objectContaining({
          sourceNodeId: node.id,
          sourcePortId: 'out',
          isSourceOutput: true,
        })
      );

      firePointer(window, 'pointermove', { clientX: 250, clientY: 180 });
      expect(updateSpy).toHaveBeenCalledWith(250, 180);
    });

    it('connects a wire to the port under the pointer when it is released', () => {
      const nodeA = openWorkflow().nodes[0];
      const nodeB = stateService.addNode('notification', 'action', 'Node B', 400, 100, {});
      fixture.detectChanges();

      firePointer(portOf(nodeA.id, 'out'), 'pointerdown', { clientX: 100, clientY: 100 });
      document.elementFromPoint = vi.fn().mockReturnValue(portOf(nodeB.id, 'in'));
      firePointer(window, 'pointerup', { clientX: 400, clientY: 120 });

      expect(stateService.isConnecting()).toBeNull();
      const edges = stateService.currentWorkflow()?.edges ?? [];
      expect(edges.length).toBe(1);
      expect(edges[0].sourceNodeId).toBe(nodeA.id);
      expect(edges[0].targetNodeId).toBe(nodeB.id);
    });

    it('drops a wire released on empty canvas', () => {
      const node = openWorkflow().nodes[0];
      firePointer(portOf(node.id, 'out'), 'pointerdown', { clientX: 100, clientY: 100 });
      firePointer(window, 'pointerup', { clientX: 400, clientY: 400 });

      expect(stateService.isConnecting()).toBeNull();
      expect(stateService.currentWorkflow()?.edges.length).toBe(0);
    });

    it('keeps the wire after a mouse click on its start port, follows the mouse, and ends it on a click on another port', () => {
      const nodeA = openWorkflow().nodes[0];
      const nodeB = stateService.addNode('notification', 'action', 'Node B', 400, 100, {});
      fixture.detectChanges();
      const updateSpy = vi.spyOn(stateService, 'updateConnecting');

      firePointer(portOf(nodeA.id, 'out'), 'pointerdown', { clientX: 100, clientY: 100 });
      firePointer(window, 'pointerup', { clientX: 102, clientY: 102 });
      expect(stateService.isConnecting()).not.toBeNull();

      // Without a button pressed the wire still follows the mouse.
      firePointer(window, 'pointermove', { clientX: 300, clientY: 150 });
      expect(updateSpy).toHaveBeenCalledWith(300, 150);

      firePointer(portOf(nodeB.id, 'in'), 'pointerdown', { clientX: 400, clientY: 120 });
      expect(stateService.isConnecting()).toBeNull();
      expect(stateService.currentWorkflow()?.edges.length).toBe(1);
      firePointer(window, 'pointerup', { clientX: 400, clientY: 120 });
    });

    it('drops a wire that waits for its end when Escape is pressed or the background is clicked', () => {
      const node = openWorkflow().nodes[0];
      firePointer(portOf(node.id, 'out'), 'pointerdown', { clientX: 100, clientY: 100 });
      firePointer(window, 'pointerup', { clientX: 100, clientY: 100 });
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(stateService.isConnecting()).toBeNull();

      firePointer(portOf(node.id, 'out'), 'pointerdown', { clientX: 100, clientY: 100 });
      firePointer(window, 'pointerup', { clientX: 100, clientY: 100 });
      firePointer(container(), 'pointerdown');
      expect(stateService.isConnecting()).toBeNull();
      firePointer(window, 'pointerup');
    });

    it('keeps the wire after a finger taps its start port, and ends it on a tap on another port', () => {
      const nodeA = openWorkflow().nodes[0];
      const nodeB = stateService.addNode('notification', 'action', 'Node B', 400, 100, {});
      fixture.detectChanges();

      firePointer(portOf(nodeA.id, 'out'), 'pointerdown', {
        clientX: 100,
        clientY: 100,
        pointerType: 'touch',
      });
      firePointer(window, 'pointerup', { clientX: 102, clientY: 102, pointerType: 'touch' });
      expect(stateService.isConnecting()).not.toBeNull();

      firePointer(portOf(nodeB.id, 'in'), 'pointerdown', {
        clientX: 400,
        clientY: 120,
        pointerType: 'touch',
        pointerId: 2,
      });
      expect(stateService.isConnecting()).toBeNull();
      expect(stateService.currentWorkflow()?.edges.length).toBe(1);
      firePointer(window, 'pointerup', { pointerType: 'touch', pointerId: 2 });
    });

    it('drops a waiting wire when the background is tapped', () => {
      const node = openWorkflow().nodes[0];
      firePointer(portOf(node.id, 'out'), 'pointerdown', {
        clientX: 100,
        clientY: 100,
        pointerType: 'touch',
      });
      firePointer(window, 'pointerup', { clientX: 100, clientY: 100, pointerType: 'touch' });
      expect(stateService.isConnecting()).not.toBeNull();

      firePointer(container(), 'pointerdown', { pointerType: 'touch', pointerId: 2 });
      expect(stateService.isConnecting()).toBeNull();
      firePointer(window, 'pointerup', { pointerType: 'touch', pointerId: 2 });
    });

    it('ignores pointers that land on the navigation controls', () => {
      const hub = fixture.nativeElement.querySelector('.canvas-navigation-hub');
      firePointer(hub, 'pointerdown', { pointerType: 'touch' });
      expect(component.isPanning()).toBe(false);
    });

    it('cleans up a node drag and a wire on pointercancel', () => {
      const node = openWorkflow().nodes[0];
      firePointer(nodeEl(node.id), 'pointerdown', {
        clientX: 100,
        clientY: 100,
        pointerType: 'touch',
      });
      expect(component.draggingNodeId()).toBe(node.id);
      expect(stateService.isDraggingNode()).toBe(false);

      firePointer(window, 'pointermove', { clientX: 120, clientY: 120, pointerType: 'touch' });
      expect(stateService.isDraggingNode()).toBe(true);

      firePointer(window, 'pointercancel', { pointerType: 'touch' });
      expect(component.draggingNodeId()).toBeNull();
      expect(stateService.isDraggingNode()).toBe(false);

      firePointer(portOf(node.id, 'out'), 'pointerdown', { pointerType: 'touch' });
      expect(stateService.isConnecting()).not.toBeNull();
      firePointer(window, 'pointercancel', { pointerType: 'touch' });
      expect(stateService.isConnecting()).toBeNull();
    });

    it('keeps the object of a wire whose ends did not move', () => {
      const nodeA = openWorkflow().nodes[0];
      const nodeB = stateService.addNode('notification', 'action', 'Node B', 400, 100, {});
      const nodeC = stateService.addNode('sync', 'task', 'Node C', 700, 100, {});
      stateService.connectPorts(nodeA.id, 'out', nodeB.id, 'in');
      for (const node of [nodeA, nodeB, nodeC]) measureNode(layoutService, node);
      const before = component.renderedWires()[0];

      stateService.updateNodesPositions(new Map([[nodeC.id, { x: 720, y: 140 }]]));
      expect(component.renderedWires()[0]).toBe(before);

      stateService.updateNodesPositions(new Map([[nodeB.id, { x: 480, y: 140 }]]));
      expect(component.renderedWires()[0]).not.toBe(before);
    });
  });

  describe('canvas size', () => {
    it('follows the canvas when the panels beside it open or close, not only the window', () => {
      const observed: { callback: () => void; target?: Element; disconnected: boolean }[] = [];
      vi.stubGlobal(
        'ResizeObserver',
        class {
          private readonly entry: { callback: () => void; target?: Element; disconnected: boolean };
          constructor(callback: () => void) {
            this.entry = { callback, disconnected: false };
            observed.push(this.entry);
          }
          observe(target: Element): void {
            this.entry.target = target;
          }
          disconnect(): void {
            this.entry.disconnected = true;
          }
        }
      );
      const second = TestBed.createComponent(WorkflowCanvasComponent);
      second.detectChanges();
      // The nodes observe their own size too; the canvas observes its container.
      const container = second.nativeElement.querySelector('.workflow-canvas-container');
      const entry = observed.find(o => o.target === container);
      expect(entry).toBeDefined();
      if (!entry) return;

      const el = entry.target as HTMLElement;
      Object.defineProperty(el, 'clientWidth', { value: 640, configurable: true });
      Object.defineProperty(el, 'clientHeight', { value: 480, configurable: true });
      entry.callback();
      expect(stateService.canvasDimensions()).toEqual({ width: 640, height: 480 });

      second.destroy();
      expect(entry.disconnected).toBe(true);
      vi.unstubAllGlobals();
    });
  });
});
