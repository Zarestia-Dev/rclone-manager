import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WorkflowMinimapComponent } from './workflow-minimap.component';
import { WorkflowNode } from '../../../types/workflow.types';
import { WorkflowNodeLayoutService } from '../../../../../services/flow/workflow-node-layout.service';

describe('WorkflowMinimapComponent', () => {
  let fixture: ComponentFixture<WorkflowMinimapComponent>;
  let component: WorkflowMinimapComponent;

  const mockNodes: WorkflowNode[] = [
    {
      id: 'n1',
      type: 'manual',
      category: 'trigger',
      title: 'Start',
      x: 0,
      y: 0,
      inputs: [],
      outputs: [],
      config: {},
    },
  ];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [WorkflowMinimapComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(WorkflowMinimapComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('nodes', mockNodes);
    fixture.componentRef.setInput('viewport', { x: 0, y: 0, zoom: 1 });
    fixture.detectChanges();
  });

  it('renders scaled nodes and viewport box', () => {
    expect(component.scaledNodes().length).toBe(1);
    expect(component.scaledNodes()[0].tone).toBe('primary');
    expect(component.viewportRect().width).toBeGreaterThan(0);
  });

  it('renders scaled edges when provided', () => {
    const nodeA: WorkflowNode = {
      id: 'n1',
      type: 'sync',
      category: 'task',
      title: 'Sync',
      x: 0,
      y: 0,
      inputs: [],
      outputs: [],
      config: {},
    };
    const nodeB: WorkflowNode = {
      id: 'n2',
      type: 'notification',
      category: 'action',
      title: 'Alert',
      x: 400,
      y: 100,
      inputs: [],
      outputs: [],
      config: {},
    };
    fixture.componentRef.setInput('nodes', [nodeA, nodeB]);
    fixture.componentRef.setInput('edges', [
      { id: 'e1', sourceNodeId: 'n1', sourcePortId: 'out', targetNodeId: 'n2', targetPortId: 'in' },
    ]);
    fixture.detectChanges();

    // A wire is drawn once both of its nodes have been measured, as on the canvas.
    expect(component.scaledEdges().length).toBe(0);
    const layout = TestBed.inject(WorkflowNodeLayoutService);
    layout.set('n1', { width: 240, height: 120, ports: { 'out:out': { x: 240, y: 100 } } });
    layout.set('n2', { width: 240, height: 120, ports: { 'in:in': { x: 0, y: 100 } } });

    expect(component.scaledEdges().length).toBe(1);
    expect(component.scaledNodes()[0].tone).toBe('primary');
    expect(component.scaledNodes()[1].tone).toBe('primary');
  });

  const pointer = (target: EventTarget, type: string, pointerId = 1): void => {
    const event = new MouseEvent(type, { clientX: 50, clientY: 50, bubbles: true });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    target.dispatchEvent(event);
  };

  it('emits panTo when pressed and while the pointer is dragged', () => {
    const pans: { x: number; y: number }[] = [];
    component.panTo.subscribe(p => pans.push(p));

    const card = fixture.nativeElement.querySelector('.workflow-minimap-card');
    pointer(card, 'pointerdown');
    expect(pans.length).toBe(1);
    expect(component.isDragging()).toBe(true);

    pointer(window, 'pointermove');
    expect(pans.length).toBe(2);

    pointer(window, 'pointerup');
    expect(component.isDragging()).toBe(false);
    pointer(window, 'pointermove');
    expect(pans.length).toBe(2);
  });

  it('ignores the pointers of other fingers while dragging', () => {
    const pans: { x: number; y: number }[] = [];
    component.panTo.subscribe(p => pans.push(p));

    pointer(fixture.nativeElement.querySelector('.workflow-minimap-card'), 'pointerdown', 1);
    pointer(window, 'pointermove', 2);
    pointer(window, 'pointerup', 2);

    expect(pans.length).toBe(1);
    expect(component.isDragging()).toBe(true);
    pointer(window, 'pointercancel', 1);
    expect(component.isDragging()).toBe(false);
  });

  describe('state of the run', () => {
    it('marks a mini node with the state of its node, and leaves the fill to its tone', () => {
      const nodes = (['idle', 'running', 'success', 'failed', 'skipped'] as const).map(
        (state, i): WorkflowNode => ({ ...mockNodes[0], id: `n${i}`, state })
      );
      fixture.componentRef.setInput('nodes', nodes);
      fixture.detectChanges();

      const minis = Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('.mini-node')
      );
      expect(minis.map(m => m.dataset['state'])).toEqual([
        'idle',
        'running',
        'success',
        'failed',
        'skipped',
      ]);
      // every one keeps the tone of its type, whatever happened to it
      expect(new Set(minis.map(m => m.dataset['tone'])).size).toBe(1);
    });
  });

  describe('the view', () => {
    const view = (x: number, y: number): void => {
      fixture.componentRef.setInput('nodes', mockNodes);
      fixture.componentRef.setInput('viewport', { x, y, zoom: 1 });
      fixture.componentRef.setInput('containerWidth', 800);
      fixture.componentRef.setInput('containerHeight', 600);
      fixture.detectChanges();
    };

    it('stays on the map when the canvas is panned far from the nodes', () => {
      view(-20000, 15000);

      const box = component.viewportRect();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(component.mapWidth + 0.001);
      expect(box.y + box.height).toBeLessThanOrEqual(component.mapHeight + 0.001);
    });

    it('does not move the map while it is dragged from the map', () => {
      view(0, 0);
      const card = fixture.nativeElement.querySelector('.workflow-minimap-card');
      const before = component.bounds();

      pointer(card, 'pointerdown');
      // the canvas follows the pointer far away
      fixture.componentRef.setInput('viewport', { x: -9000, y: -7000, zoom: 1 });
      fixture.detectChanges();
      expect(component.bounds()).toEqual(before);

      pointer(window, 'pointerup');
      fixture.detectChanges();
      expect(component.bounds()).not.toEqual(before);
    });
  });
});
