import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WorkflowWireComponent } from './workflow-wire.component';
import { WorkflowEdge } from '../../../types/workflow.types';
import { provideTranslateService } from '@ngx-translate/core';

describe('WorkflowWireComponent', () => {
  let fixture: ComponentFixture<WorkflowWireComponent>;
  let component: WorkflowWireComponent;

  const mockEdge: WorkflowEdge = {
    id: 'edge-1',
    sourceNodeId: 'node-1',
    sourcePortId: 'out',
    targetNodeId: 'node-2',
    targetPortId: 'in',
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [WorkflowWireComponent],
      providers: [provideTranslateService()],
    }).compileComponents();

    fixture = TestBed.createComponent(WorkflowWireComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('edge', mockEdge);
    fixture.componentRef.setInput('sourcePos', { x: 100, y: 100 });
    fixture.componentRef.setInput('targetPos', { x: 300, y: 200 });
    fixture.detectChanges();
  });

  it('computes valid SVG path and midpoint', () => {
    expect(component.pathD()).toContain('M 100 100 C');
    expect(component.midpoint().x).toBeGreaterThan(100);
    expect(component.midpoint().x).toBeLessThan(300);
  });

  it('emits selectWire when hitbox is clicked', () => {
    let selectedId = '';
    component.selectWire.subscribe(id => (selectedId = id));

    const hitbox = fixture.nativeElement.querySelector('.wire-hitbox');
    hitbox.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(selectedId).toBe('edge-1');
  });

  it('emits removeWire when action handle is clicked on selected wire', () => {
    fixture.componentRef.setInput('isSelected', true);
    fixture.detectChanges();

    let removedId = '';
    component.removeWire.subscribe(id => (removedId = id));

    const handle = fixture.nativeElement.querySelector('.wire-action-handle');
    expect(handle).toBeTruthy();
    handle.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(removedId).toBe('edge-1');
  });
});
