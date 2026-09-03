import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { RcEditorModalComponent } from './rc-editor-modal.component';
import { WorkflowStateService } from '../../../../services/flow/workflow-state.service';
import { RemoteFacadeService } from '../../../../services/facade/remote-facade.service';
import { WorkflowNode } from '../../types/workflow.types';

describe('RcEditorModalComponent', () => {
  let fixture: ComponentFixture<RcEditorModalComponent>;
  let component: RcEditorModalComponent;
  let dialogRefSpy: { close: ReturnType<typeof vi.fn> };
  let workflowStateSpy: {
    updateNodeConfig: ReturnType<typeof vi.fn>;
    currentWorkflow: ReturnType<typeof vi.fn>;
  };
  let remoteFacadeSpy: { orderedVisibleRemotes: ReturnType<typeof vi.fn> };

  const mockNode: WorkflowNode = {
    id: 'node-rc-1',
    type: 'rc_command',
    category: 'task',
    title: 'Refresh VFS Cache',
    x: 0,
    y: 0,
    inputs: [],
    outputs: [],
    config: {
      command: 'vfs/refresh',
      params: { recursive: true },
    },
  };

  beforeEach(async () => {
    dialogRefSpy = { close: vi.fn() };
    workflowStateSpy = {
      updateNodeConfig: vi.fn(),
      currentWorkflow: vi.fn().mockReturnValue({
        id: 'wf-1',
        nodes: [mockNode],
        edges: [],
      }),
    };
    remoteFacadeSpy = {
      orderedVisibleRemotes: vi.fn().mockReturnValue([{ name: 'mygdrive', type: 'drive' }]),
    };

    await TestBed.configureTestingModule({
      imports: [RcEditorModalComponent],
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: dialogRefSpy },
        { provide: MAT_DIALOG_DATA, useValue: { node: mockNode } },
        { provide: WorkflowStateService, useValue: workflowStateSpy },
        { provide: RemoteFacadeService, useValue: remoteFacadeSpy },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(RcEditorModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('initializes with node command and params', () => {
    expect(component.command()).toBe('vfs/refresh');
    expect(component.rawParamsJson()).toBe(JSON.stringify({ recursive: true }, null, 2));
  });

  it('filters presets by category', () => {
    component.setPresetCategory('vfs');
    expect(component.filteredPresets().every(p => p.category === 'vfs')).toBe(true);

    component.setPresetCategory('all');
    expect(component.filteredPresets().length).toBe(component.rcPresets.length);
  });

  it('applies preset command and params', () => {
    component.rawParamsJson.set('');
    component.applyRcPreset('operations/cleanup', { fs: 'remote:' });
    expect(component.command()).toBe('operations/cleanup');
    expect(component.rawParamsJson()).toContain('mygdrive:');
  });

  it('formats JSON and clears params', () => {
    component.rawParamsJson.set('{"test":123}');
    component.formatJson();
    expect(component.rawParamsJson()).toBe('{\n  "test": 123\n}');

    component.clearParams();
    expect(component.rawParamsJson()).toBe('');
  });

  it('evaluates jsonStatus correctly', () => {
    component.rawParamsJson.set('{"valid": true}');
    expect(component.jsonStatus().valid).toBe(true);
    expect(component.jsonStatus().isTemplate).toBe(false);

    component.rawParamsJson.set('{"path": "{{nodes.n1.out}}"}');
    expect(component.jsonStatus().valid).toBe(true);
    expect(component.jsonStatus().isTemplate).toBe(true);

    component.rawParamsJson.set('{broken json');
    expect(component.jsonStatus().valid).toBe(false);
  });

  it('closes without changes on dismiss', () => {
    component.dismiss();
    expect(dialogRefSpy.close).toHaveBeenCalledWith();
  });

  it('updates workflow state and closes on save', () => {
    component.command.set('core/bwlimit');
    component.rawParamsJson.set('{"rate": "20M"}');
    component.save();

    expect(workflowStateSpy.updateNodeConfig).toHaveBeenCalledWith('node-rc-1', {
      command: 'core/bwlimit',
      params: { rate: '20M' },
    });
    expect(dialogRefSpy.close).toHaveBeenCalledWith({
      command: 'core/bwlimit',
      params: { rate: '20M' },
    });
  });
});
