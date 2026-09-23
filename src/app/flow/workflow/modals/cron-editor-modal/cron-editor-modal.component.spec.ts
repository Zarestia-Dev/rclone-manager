import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { CronEditorModalComponent } from './cron-editor-modal.component';
import { WorkflowStateService } from '../../../../services/flow/workflow-state.service';
import { WorkflowNode } from '../../types/workflow.types';

describe('CronEditorModalComponent', () => {
  let fixture: ComponentFixture<CronEditorModalComponent>;
  let component: CronEditorModalComponent;
  let dialogRefSpy: { close: ReturnType<typeof vi.fn> };
  let workflowStateSpy: { updateNodeConfig: ReturnType<typeof vi.fn> };

  const mockNode: WorkflowNode = {
    id: 'node-cron-1',
    type: 'cron',
    category: 'trigger',
    title: 'Daily Backup Cron',
    x: 0,
    y: 0,
    inputs: [],
    outputs: [],
    config: {
      cronExpression: '0 3 * * *',
    },
  };

  beforeEach(async () => {
    dialogRefSpy = { close: vi.fn() };
    workflowStateSpy = { updateNodeConfig: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [CronEditorModalComponent],
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: dialogRefSpy },
        { provide: MAT_DIALOG_DATA, useValue: { node: mockNode } },
        { provide: WorkflowStateService, useValue: workflowStateSpy },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(CronEditorModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('initializes with node cronExpression', () => {
    expect(component.cronExpression()).toBe('0 3 * * *');
  });

  it('updates cronExpression when cron changes', () => {
    component.onCronChange('0 12 * * 1-5');
    expect(component.cronExpression()).toBe('0 12 * * 1-5');
  });

  it('updates validation state', () => {
    component.onValidationChange({ isValid: false, nextRun: undefined });
    expect(component.isValid()).toBe(false);

    component.onValidationChange({ isValid: true, nextRun: '2026-09-04T00:00:00Z' });
    expect(component.isValid()).toBe(true);
  });

  it('closes without changes on dismiss', () => {
    component.dismiss();
    expect(dialogRefSpy.close).toHaveBeenCalledWith();
  });

  it('updates workflow state and closes with cron on save', () => {
    component.onCronChange('0 0 * * *');
    component.save();

    expect(workflowStateSpy.updateNodeConfig).toHaveBeenCalledWith('node-cron-1', {
      cronExpression: '0 0 * * *',
    });
    expect(dialogRefSpy.close).toHaveBeenCalledWith('0 0 * * *');
  });
});
