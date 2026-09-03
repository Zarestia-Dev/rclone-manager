import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WorkflowCanvasComponent } from './workflow-canvas.component';
import { WorkflowStateService } from '../../../../services/flow/workflow-state.service';
import { WorkflowEngineService } from '../../../../services/flow/workflow-engine.service';
import { ModalService } from '../../../../services/ui/modal.service';
import { provideTranslateService } from '@ngx-translate/core';

describe('WorkflowCanvasComponent', () => {
  let fixture: ComponentFixture<WorkflowCanvasComponent>;
  let component: WorkflowCanvasComponent;
  let stateService: WorkflowStateService;
  let modalServiceSpy: { openWorkflowNodeEditor: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    modalServiceSpy = { openWorkflowNodeEditor: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [WorkflowCanvasComponent],
      providers: [
        provideTranslateService(),
        WorkflowStateService,
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
    stateService.createNewWorkflow('Canvas Test');

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
});
