import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WorkflowDragDropService } from './workflow-drag-drop.service';
import { WorkflowStateService } from './workflow-state.service';
import { provideTranslateService } from '@ngx-translate/core';
import { NodePaletteItem } from '../../flow/workflow/types/workflow.types';

const MOCK_PALETTE_ITEM: NodePaletteItem = {
  type: 'sync',
  category: 'task',
  title: 'Sync',
  description: 'Sync directory',
  icon: 'sync',
  defaultInputs: [{ id: 'in', name: 'in', type: 'in', label: 'In' }],
  defaultOutputs: [{ id: 'out', name: 'out', type: 'out', label: 'Out' }],
  defaultConfig: { sourceRemote: 'drive:' },
};

describe('WorkflowDragDropService', () => {
  let service: WorkflowDragDropService;
  let stateService: WorkflowStateService;
  let canvasContainer: HTMLDivElement;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [WorkflowDragDropService, WorkflowStateService, provideTranslateService()],
    });

    service = TestBed.inject(WorkflowDragDropService);
    stateService = TestBed.inject(WorkflowStateService);
    stateService.createNewWorkflow('Drag Test');

    // Create a mock canvas container in document
    canvasContainer = document.createElement('div');
    canvasContainer.className = 'workflow-canvas-container';
    canvasContainer.style.position = 'fixed';
    canvasContainer.style.left = '100px';
    canvasContainer.style.top = '100px';
    canvasContainer.style.width = '800px';
    canvasContainer.style.height = '600px';
    vi.spyOn(canvasContainer, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(100, 100, 800, 600)
    );
    document.body.appendChild(canvasContainer);
  });

  afterEach(() => {
    service.cancelDrag();
    canvasContainer.remove();
    document.querySelectorAll('.workflow-drag-ghost').forEach(el => el.remove());
  });

  it('starts inactive with no dragged item', () => {
    expect(service.isDragging()).toBe(false);
    expect(service.draggedItem()).toBeNull();
  });

  it('begins drag, sets signals, and attaches ghost to document', () => {
    service.beginDrag(MOCK_PALETTE_ITEM, { x: 50, y: 50 });

    expect(service.isDragging()).toBe(true);
    expect(service.draggedItem()).toEqual(MOCK_PALETTE_ITEM);

    const ghost = document.querySelector('.workflow-drag-ghost');
    expect(ghost).toBeTruthy();
  });

  it('updates drag position smoothly', () => {
    service.beginDrag(MOCK_PALETTE_ITEM, { x: 50, y: 50 });
    service.updateDrag({ x: 120, y: 140 });

    const ghost = document.querySelector('.workflow-drag-ghost') as HTMLElement;
    expect(ghost).toBeTruthy();
    expect(ghost.style.transform).toContain('translate3d');
  });

  it('cancels drag cleanly and removes ghost element', () => {
    service.beginDrag(MOCK_PALETTE_ITEM, { x: 50, y: 50 });
    expect(document.querySelector('.workflow-drag-ghost')).toBeTruthy();

    service.cancelDrag();
    expect(service.isDragging()).toBe(false);
    expect(service.draggedItem()).toBeNull();
    expect(document.querySelector('.workflow-drag-ghost')).toBeNull();
  });

  it('commits drop onto canvas container and adds node to workflow state', () => {
    const addNodeSpy = vi.spyOn(stateService, 'addNode');

    service.beginDrag(MOCK_PALETTE_ITEM, { x: 50, y: 50 });

    // Simulate drop inside canvas container (left: 100, top: 100)
    // Point: (300, 250) -> canvas coords = (300 - 100 - 0) / 1 = 200, (250 - 100 - 0) / 1 = 150
    const result = service.commitDrag({ x: 300, y: 250 });

    expect(result).toBeTruthy();
    expect(result?.canvasX).toBe(200);
    expect(result?.canvasY).toBe(150);
    expect(addNodeSpy).toHaveBeenCalledWith(
      'sync',
      'task',
      'Sync',
      200,
      150,
      expect.objectContaining({
        icon: 'sync',
      })
    );

    expect(service.isDragging()).toBe(false);
    expect(document.querySelector('.workflow-drag-ghost')).toBeNull();
  });

  it('returns null and does not add node if dropped outside canvas', () => {
    const addNodeSpy = vi.spyOn(stateService, 'addNode');

    service.beginDrag(MOCK_PALETTE_ITEM, { x: 50, y: 50 });

    // Point outside canvas container bounds (left: 100, top: 100, right: 900, bottom: 700)
    const result = service.commitDrag({ x: 20, y: 20 });

    expect(result).toBeNull();
    expect(addNodeSpy).not.toHaveBeenCalled();
    expect(service.isDragging()).toBe(false);
  });
});
