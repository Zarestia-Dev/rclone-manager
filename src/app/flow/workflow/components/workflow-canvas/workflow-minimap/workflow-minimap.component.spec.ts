import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WorkflowMinimapComponent } from './workflow-minimap.component';
import { WorkflowNode } from '../../../types/workflow.types';

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
    expect(component.scaledNodes()[0].colorClass).toBe('primary');
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

    expect(component.scaledEdges().length).toBe(1);
    expect(component.scaledNodes()[0].colorClass).toBe('primary');
    expect(component.scaledNodes()[1].colorClass).toBe('primary');
  });

  it('emits panTo on click', () => {
    let panResult: { x: number; y: number } | null = null;
    component.panTo.subscribe(p => (panResult = p));

    const card = fixture.nativeElement.querySelector('.workflow-minimap-card');
    card.dispatchEvent(new MouseEvent('click', { clientX: 50, clientY: 50, bubbles: true }));

    expect(panResult).toBeTruthy();
  });
});
