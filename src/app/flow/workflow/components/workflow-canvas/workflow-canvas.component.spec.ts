import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WorkflowCanvasComponent } from './workflow-canvas.component';
import { WorkflowStateService } from '../../../../services/flow/workflow-state.service';
import { WorkflowEngineService } from '../../../../services/flow/workflow-engine.service';
import { WorkflowDragDropService } from '../../../../services/flow/workflow-drag-drop.service';
import { ModalService } from '../../../../services/ui/modal.service';
import { provideTranslateService } from '@ngx-translate/core';

describe('WorkflowCanvasComponent', () => {
  let fixture: ComponentFixture<WorkflowCanvasComponent>;
  let component: WorkflowCanvasComponent;
  let stateService: WorkflowStateService;
  let dragDropService: WorkflowDragDropService;
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

  it('handles 1-finger touch pan on canvas container', () => {
    const setPanSpy = vi.spyOn(stateService, 'setPan');

    // Touch start
    component.onCanvasTouchStart({
      touches: [{ clientX: 100, clientY: 100 }],
      target: fixture.nativeElement.querySelector('.workflow-canvas-container'),
    } as unknown as TouchEvent);
    expect(component.isPanning()).toBe(true);

    // Touch move
    component.onCanvasTouchMove({
      touches: [{ clientX: 150, clientY: 120 }],
      preventDefault: vi.fn(),
    } as unknown as TouchEvent);
    expect(setPanSpy).toHaveBeenCalledWith(50, 20);

    // Touch end
    component.onCanvasTouchEnd({
      touches: [],
    } as unknown as TouchEvent);
    expect(component.isPanning()).toBe(false);
  });

  it('handles 2-finger touch pinch zoom on canvas', () => {
    const setZoomSpy = vi.spyOn(stateService, 'setZoom');

    // Pinch start with 2 touches separated by 100px
    component.onCanvasTouchStart({
      touches: [
        { clientX: 100, clientY: 100 },
        { clientX: 200, clientY: 100 },
      ],
      target: fixture.nativeElement.querySelector('.workflow-canvas-container'),
    } as unknown as TouchEvent);

    // Pinch move separated by 150px (scale = 1.5)
    component.onCanvasTouchMove({
      touches: [
        { clientX: 75, clientY: 100 },
        { clientX: 225, clientY: 100 },
      ],
      preventDefault: vi.fn(),
    } as unknown as TouchEvent);

    expect(setZoomSpy).toHaveBeenCalledWith(
      expect.closeTo(1.5, 0.1),
      expect.any(Number),
      expect.any(Number)
    );
  });

  it('handles node touch start for dragging on mobile', () => {
    const currentWf = stateService.currentWorkflow();
    expect(currentWf).toBeTruthy();
    if (!currentWf) return;
    const node = currentWf.nodes[0];
    const selectSpy = vi.spyOn(stateService, 'selectNode');

    component.onNodeTouchStart(node, {
      touches: [{ clientX: 120, clientY: 120 }],
      stopPropagation: vi.fn(),
    } as unknown as TouchEvent);

    expect(component.draggingNodeId()).toBe(node.id);
    expect(selectSpy).toHaveBeenCalledWith(node.id, false);
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
    stateService.connectPorts(nodeA.id, 'out', nodeB.id, 'in');

    const wires = component.renderedWires();
    expect(wires.length).toBe(1);
    expect(wires[0].edge.sourceNodeId).toBe(nodeA.id);
    expect(wires[0].edge.targetNodeId).toBe(nodeB.id);
    expect(wires[0].sourcePos.x).toBeGreaterThan(nodeA.x);
    expect(wires[0].targetPos.x).toBe(nodeB.x);
  });

  it('computes bidirectional connecting bezier path correctly', () => {
    const nodeA = stateService.addNode('sync', 'task', 'Node A', 100, 100, {});

    // 1. Forward connection (output to mouse)
    stateService.startConnecting(nodeA.id, 'out', 300, 200, true);
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

    component.onNodeMouseDown(nodeA, {
      button: 0,
      clientX: 100,
      clientY: 100,
      stopPropagation: vi.fn(),
    } as unknown as MouseEvent);

    expect(component.draggingNodeId()).toBe(nodeA.id);

    // MouseMove by dx=48, dy=32
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 148, clientY: 132 }));

    const updatedA = stateService.currentWorkflow()?.nodes.find(n => n.id === nodeA.id);
    const updatedB = stateService.currentWorkflow()?.nodes.find(n => n.id === nodeB.id);

    expect(updatedA?.x).toBeGreaterThan(100);
    expect(updatedB?.x).toBeGreaterThan(300);

    // MouseUp finishes drag
    window.dispatchEvent(new MouseEvent('mouseup'));
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

  it('handles navigation action for desktop and mobile modes', () => {
    // Desktop mode (isMobile = false)
    component.isMobile.set(false);
    expect(component.navigationActionIcon()).toBe('detailed');
    expect(component.showMinimap()).toBe(true);

    component.toggleNavigationAction();
    expect(component.showMinimap()).toBe(false);

    // Mobile mode (isMobile = true)
    component.isMobile.set(true);
    expect(stateService.isMobileFocusMode()).toBe(false);
    expect(component.navigationActionIcon()).toBe('caret-down');

    component.toggleNavigationAction();
    expect(stateService.isMobileFocusMode()).toBe(true);
    expect(component.navigationActionIcon()).toBe('caret-up');

    // ngOnDestroy cleans up focus mode
    component.ngOnDestroy();
    expect(stateService.isMobileFocusMode()).toBe(false);
  });

  describe('Touch and Mobile Canvas Interactions', () => {
    let originalElementFromPoint: typeof document.elementFromPoint;

    beforeEach(() => {
      originalElementFromPoint = document.elementFromPoint;
      document.elementFromPoint = vi.fn().mockReturnValue(null);
    });

    afterEach(() => {
      document.elementFromPoint = originalElementFromPoint;
    });

    it('does not start node drag if touch target is a port handle or action button', () => {
      const currentWf = stateService.currentWorkflow();
      expect(currentWf).toBeTruthy();
      if (!currentWf) return;
      const node = currentWf.nodes[0];

      const portMock = document.createElement('div');
      portMock.classList.add('port-handle');

      component.onNodeTouchStart(node, {
        touches: [{ clientX: 120, clientY: 120 }],
        target: portMock,
        stopPropagation: vi.fn(),
      } as unknown as TouchEvent);

      expect(component.draggingNodeId()).toBeNull();
      expect(stateService.isDraggingNode()).toBe(false);
    });

    it('updates connecting wire coordinates on touch move while connecting', () => {
      const nodeA = stateService.addNode('sync', 'task', 'Node A', 100, 100, {});
      stateService.startConnecting(nodeA.id, 'out', 100, 100, true);

      const containerEl = fixture.nativeElement.querySelector('.workflow-canvas-container');
      vi.spyOn(containerEl, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 1000,
        height: 700,
        right: 1000,
        bottom: 700,
      } as DOMRect);

      const updateSpy = vi.spyOn(stateService, 'updateConnecting');

      component.onCanvasTouchMove({
        touches: [{ clientX: 250, clientY: 180 }],
        preventDefault: vi.fn(),
      } as unknown as TouchEvent);

      expect(updateSpy).toHaveBeenCalledWith(250, 180);
    });

    it('completes connection via document.elementFromPoint on touch end', () => {
      const nodeA = stateService.addNode('sync', 'task', 'Node A', 100, 100, {});
      const nodeB = stateService.addNode('notification', 'action', 'Node B', 400, 100, {});
      stateService.startConnecting(nodeA.id, 'out', 100, 100, true);

      const mockTargetPort = document.createElement('div');
      mockTargetPort.className = 'port-handle';
      mockTargetPort.setAttribute('data-node-id', nodeB.id);
      mockTargetPort.setAttribute('data-port-id', 'in');
      mockTargetPort.setAttribute('data-is-output', 'false');

      document.elementFromPoint = vi.fn().mockReturnValue(mockTargetPort);

      component.onCanvasTouchEnd({
        touches: [],
        changedTouches: [{ clientX: 400, clientY: 120 }],
      } as unknown as TouchEvent);

      expect(stateService.isConnecting()).toBeNull();
      const edges = stateService.currentWorkflow()?.edges ?? [];
      expect(edges.length).toBe(1);
      expect(edges[0].sourceNodeId).toBe(nodeA.id);
      expect(edges[0].targetNodeId).toBe(nodeB.id);
    });

    it('leaves connection active on touch end if tap is near start position (tap-to-connect)', () => {
      const nodeA = stateService.addNode('sync', 'task', 'Node A', 100, 100, {});
      component.onStartConnecting(nodeA.id, 'out', true, {
        clientX: 100,
        clientY: 100,
      } as unknown as PointerEvent);

      component.onCanvasTouchEnd({
        touches: [],
        changedTouches: [{ clientX: 102, clientY: 102 }],
      } as unknown as TouchEvent);

      expect(stateService.isConnecting()).not.toBeNull();
    });

    it('ignores canvas touch start on interactive controls to avoid initiating pan', () => {
      const hubEl = fixture.nativeElement.querySelector('.canvas-navigation-hub');
      expect(hubEl).toBeTruthy();

      component.onCanvasTouchStart({
        touches: [{ clientX: 100, clientY: 100 }],
        target: hubEl,
      } as unknown as TouchEvent);

      expect(component.isPanning()).toBe(false);
    });

    it('cleans up drag and connect states on window touchcancel', () => {
      const currentWf = stateService.currentWorkflow();
      expect(currentWf).toBeTruthy();
      if (!currentWf) return;
      const node = currentWf.nodes[0];

      component.onNodeTouchStart(node, {
        touches: [{ clientX: 100, clientY: 100 }],
        target: document.createElement('div'),
        stopPropagation: vi.fn(),
      } as unknown as TouchEvent);

      expect(component.draggingNodeId()).toBe(node.id);
      expect(stateService.isDraggingNode()).toBe(false);

      component.onCanvasTouchMove({
        touches: [{ clientX: 120, clientY: 120 }],
        preventDefault: vi.fn(),
      } as unknown as TouchEvent);

      expect(stateService.isDraggingNode()).toBe(true);

      window.dispatchEvent(new Event('touchcancel'));

      expect(component.draggingNodeId()).toBeNull();
      expect(stateService.isDraggingNode()).toBe(false);
    });
  });
});
