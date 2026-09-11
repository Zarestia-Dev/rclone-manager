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
        title: 'Sync',
        description: '',
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
});
