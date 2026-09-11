import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WorkflowPaletteComponent } from './workflow-palette.component';
import { WorkflowStateService } from '../../../../services/flow/workflow-state.service';
import { WorkflowDragDropService } from '../../../../services/flow/workflow-drag-drop.service';
import { provideTranslateService } from '@ngx-translate/core';
import { WorkflowNode } from '../../types/workflow.types';

describe('WorkflowPaletteComponent', () => {
  let fixture: ComponentFixture<WorkflowPaletteComponent>;
  let component: WorkflowPaletteComponent;
  let stateService: WorkflowStateService;
  let dragDropService: WorkflowDragDropService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [WorkflowPaletteComponent],
      providers: [provideTranslateService(), WorkflowStateService, WorkflowDragDropService],
    }).compileComponents();

    stateService = TestBed.inject(WorkflowStateService);
    dragDropService = TestBed.inject(WorkflowDragDropService);
    stateService.createNewWorkflow('Palette Test');

    fixture = TestBed.createComponent(WorkflowPaletteComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders categories and palette items', () => {
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.palette-title')).toBeTruthy();
    expect(component.filteredItems().length).toBeGreaterThan(0);
  });

  it('ensures all palette items have unique types to avoid @for track key collisions', () => {
    const allTypes = component.filteredItems().map(i => i.type);
    const uniqueTypes = new Set(allTypes);
    expect(allTypes.length).toBe(uniqueTypes.size);
  });

  it('filters items by search query', () => {
    component.searchQuery.set('Cron');
    fixture.detectChanges();
    expect(component.filteredItems().some(i => i.title.includes('Cron'))).toBe(true);
    expect(component.filteredItems().some(i => i.title === 'Move')).toBe(false);
  });

  it('filters items by category', () => {
    component.selectedCategory.set('trigger');
    fixture.detectChanges();
    expect(component.filteredItems().every(i => i.category === 'trigger')).toBe(true);
  });

  it('includes all primary operations from OPERATION_REGISTRY in task category', () => {
    component.selectedCategory.set('task');
    fixture.detectChanges();
    const taskTypes = component.filteredItems().map(i => i.type);
    expect(taskTypes).toContain('sync');
    expect(taskTypes).toContain('copy');
    expect(taskTypes).toContain('move');
    expect(taskTypes).toContain('bisync');
    expect(taskTypes).toContain('mount');
    expect(taskTypes).toContain('serve');
    expect(taskTypes).toContain('check');
    expect(taskTypes).toContain('delete');
    expect(taskTypes).toContain('copyurl');
    expect(taskTypes).toContain('archivecreate');
    expect(taskTypes).toContain('cleanup');
    expect(taskTypes).toContain('cryptcheck');
    expect(taskTypes).toContain('exec_script');
    expect(taskTypes).toContain('quick_run');
    expect(taskTypes).toContain('rc_command');
  });

  it('includes app_start in trigger category', () => {
    component.selectedCategory.set('trigger');
    fixture.detectChanges();
    const triggerTypes = component.filteredItems().map(i => i.type);
    expect(triggerTypes).toContain('app_start');
    expect(triggerTypes).toContain('manual');
    expect(triggerTypes).toContain('cron');
    expect(triggerTypes).toContain('watcher');
    expect(triggerTypes).toContain('job_event');
  });

  it('includes stop in logic category', () => {
    component.selectedCategory.set('logic');
    fixture.detectChanges();
    const logicTypes = component.filteredItems().map(i => i.type);
    expect(logicTypes).toContain('stop');
    expect(logicTypes).toContain('condition');
    expect(logicTypes).toContain('delay');
    expect(logicTypes).toContain('parallel_fork');
    expect(logicTypes).toContain('join');
  });

  it('includes notification, unmount, stop_serve, system_power and log_audit in action category', () => {
    component.selectedCategory.set('action');
    fixture.detectChanges();
    const actionTypes = component.filteredItems().map(i => i.type);
    expect(actionTypes).toContain('notification');
    expect(actionTypes).toContain('unmount');
    expect(actionTypes).toContain('stop_serve');
    expect(actionTypes).toContain('system_power');
    expect(actionTypes).toContain('log_audit');
    const notifItem = component.filteredItems().find(i => i.type === 'notification');
    expect(notifItem).toBeDefined();
    expect(notifItem?.title).toBe('Send Notification');
  });

  it('emits closePalette when close button is clicked', () => {
    let emitted = false;
    component.closePalette.subscribe(() => {
      emitted = true;
    });

    const el: HTMLElement = fixture.nativeElement;
    const closeBtn = el.querySelector('.palette-close-btn') as HTMLButtonElement;
    expect(closeBtn).toBeTruthy();
    closeBtn.click();
    expect(emitted).toBe(true);
  });

  it('adds node to canvas and emits nodeAdded on addNodeToCanvas call', () => {
    const item = component.filteredItems()[0];
    let emittedItem = null;
    component.nodeAdded.subscribe(emitted => {
      emittedItem = emitted;
    });

    const addNodeSpy = vi.spyOn(stateService, 'addNode');
    component.addNodeToCanvas(item);

    expect(addNodeSpy).toHaveBeenCalled();
    expect(emittedItem).toEqual(item);
  });

  it('initiates drag and updates WorkflowDragDropService on pointerdown followed by movement', () => {
    const beginDragSpy = vi.spyOn(dragDropService, 'beginDrag');
    const updateDragSpy = vi.spyOn(dragDropService, 'updateDrag');
    const item = component.filteredItems()[0];

    // Pointer down
    component.onItemPointerDown(item, {
      button: 0,
      pointerId: 1,
      clientX: 50,
      clientY: 50,
      currentTarget: fixture.nativeElement.querySelector('.palette-item-card'),
    } as unknown as PointerEvent);

    // Minor movement (< 8px) should NOT begin drag
    window.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: 1, clientX: 53, clientY: 53 })
    );
    expect(beginDragSpy).not.toHaveBeenCalled();

    // Movement (>= 8px) should begin drag
    window.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: 1, clientX: 70, clientY: 70 })
    );
    expect(beginDragSpy).toHaveBeenCalledWith(item, { x: 70, y: 70 }, null);

    // Subsequent movement updates drag
    window.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: 1, clientX: 85, clientY: 90 })
    );
    expect(updateDragSpy).toHaveBeenCalledWith({ x: 85, y: 90 });

    // Pointer up commits and emits nodeAdded if drop succeeds
    vi.spyOn(dragDropService, 'commitDrag').mockReturnValue({
      item,
      canvasX: 200,
      canvasY: 200,
      node: { id: 'n-1', type: item.type } as unknown as WorkflowNode,
    });

    let emittedItem = null;
    component.nodeAdded.subscribe(emitted => {
      emittedItem = emitted;
    });

    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 85, clientY: 90 }));
    expect(emittedItem).toEqual(item);
  });
});
