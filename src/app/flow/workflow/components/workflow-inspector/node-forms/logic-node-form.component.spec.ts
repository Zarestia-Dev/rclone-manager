import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { LogicNodeFormComponent } from './logic-node-form.component';
import { WorkflowNode } from '../../../types/workflow.types';
import { WorkflowStateService } from '../../../../../services/flow/workflow-state.service';

describe('LogicNodeFormComponent', () => {
  let fixture: ComponentFixture<LogicNodeFormComponent>;
  let component: LogicNodeFormComponent;

  const mockNode: WorkflowNode = {
    id: 'node-delay-1',
    type: 'delay',
    category: 'logic',
    title: 'Delay Node',
    x: 0,
    y: 0,
    inputs: [],
    outputs: [],
    config: { seconds: 5 },
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LogicNodeFormComponent],
      providers: [provideTranslateService()],
    }).compileComponents();

    fixture = TestBed.createComponent(LogicNodeFormComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('node', mockNode);
    fixture.componentRef.setInput('nodeConfig', { seconds: 5 });
    fixture.detectChanges();
  });

  it('emits configChange when delay preset is applied', () => {
    let emitted: { key: string; value: unknown } | null = null;
    component.configChange.subscribe(val => {
      emitted = val;
    });

    component.applyDelayPreset(60);
    expect(emitted).toEqual({ key: 'seconds', value: 60 });

    component.applyDelayPreset(300);
    expect(emitted).toEqual({ key: 'seconds', value: 300 });
  });

  it('computes delaySecondsValue correctly with seconds key', () => {
    expect(component.delaySecondsValue()).toBe(5);

    fixture.componentRef.setInput('nodeConfig', { seconds: 20 });
    fixture.detectChanges();
    expect(component.delaySecondsValue()).toBe(20);

    fixture.componentRef.setInput('nodeConfig', { seconds: '45' });
    fixture.detectChanges();
    expect(component.delaySecondsValue()).toBe(45);
  });

  it('emits configChange on onFieldChange', () => {
    let emitted: { key: string; value: unknown } | null = null;
    component.configChange.subscribe(val => {
      emitted = val;
    });

    component.onFieldChange('operator', 'contains');
    expect(emitted).toEqual({ key: 'operator', value: 'contains' });
  });

  it('handles join node joinMode change and branch additions/removals', () => {
    const joinNode: WorkflowNode = {
      id: 'node-join-1',
      type: 'join',
      category: 'logic',
      title: 'Join Branches',
      x: 0,
      y: 0,
      inputs: [
        { id: 'in1', name: 'In 1', type: 'in' },
        { id: 'in2', name: 'In 2', type: 'in' },
      ],
      outputs: [{ id: 'out', name: 'Done', type: 'out' }],
      config: { joinMode: 'all_success' },
    };

    fixture.componentRef.setInput('node', joinNode);
    fixture.componentRef.setInput('nodeConfig', { joinMode: 'all_success' });
    fixture.detectChanges();

    // canRemoveBranch is false when length is 2
    expect(component.canRemoveBranch()).toBe(false);

    // emit joinMode change
    let emitted: { key: string; value: unknown } | null = null;
    component.configChange.subscribe(val => {
      emitted = val;
    });
    component.onFieldChange('joinMode', 'any_success');
    expect(emitted).toEqual({ key: 'joinMode', value: 'any_success' });

    // When 3 inputs, canRemoveBranch is true
    const nodeWith3Inputs: WorkflowNode = {
      ...joinNode,
      inputs: [...joinNode.inputs, { id: 'in3', name: 'In 3', type: 'in' }],
    };
    fixture.componentRef.setInput('node', nodeWith3Inputs);
    fixture.detectChanges();
    expect(component.canRemoveBranch()).toBe(true);

    // Call add and remove methods
    component.addInputBranch();
    component.removeInputBranch('in3');
  });

  it('handles parallel_fork node branch additions, removals and canRemoveOutputBranch', () => {
    const forkNode: WorkflowNode = {
      id: 'node-fork-1',
      type: 'parallel_fork',
      category: 'logic',
      title: 'Parallel Split',
      x: 0,
      y: 0,
      inputs: [{ id: 'in', name: 'In', type: 'in' }],
      outputs: [
        { id: 'branch1', name: 'Branch 1', type: 'out' },
        { id: 'branch2', name: 'Branch 2', type: 'out' },
      ],
      config: {},
    };

    fixture.componentRef.setInput('node', forkNode);
    fixture.componentRef.setInput('nodeConfig', {});
    fixture.detectChanges();

    // canRemoveOutputBranch is false when length is 2
    expect(component.canRemoveOutputBranch()).toBe(false);

    // When 3 outputs, canRemoveOutputBranch is true
    const nodeWith3Outputs: WorkflowNode = {
      ...forkNode,
      outputs: [...forkNode.outputs, { id: 'branch3', name: 'Branch 3', type: 'out' }],
    };
    fixture.componentRef.setInput('node', nodeWith3Outputs);
    fixture.detectChanges();
    expect(component.canRemoveOutputBranch()).toBe(true);

    // Call add and remove methods
    component.addOutputBranch();
    component.removeOutputBranch('branch3');
  });

  describe('condition node', () => {
    let stateService: WorkflowStateService;

    const conditionNode: WorkflowNode = {
      id: 'node-cond-1',
      type: 'condition',
      category: 'logic',
      title: 'Condition Branch',
      x: 0,
      y: 0,
      inputs: [{ id: 'in', name: 'In', type: 'in' }],
      outputs: [
        { id: 'true', name: 'True', type: 'true' },
        { id: 'false', name: 'False', type: 'false' },
      ],
      config: { operator: 'equals', leftValue: 'foo', rightValue: 'bar' },
    };

    beforeEach(() => {
      stateService = TestBed.inject(WorkflowStateService);
      stateService.currentWorkflow.set({
        id: 'wf-1',
        name: 'Test WF',
        nodes: [
          {
            id: 'node-sync-1',
            type: 'sync',
            category: 'task',
            title: 'Backup Sync',
            x: 0,
            y: 0,
            inputs: [],
            outputs: [],
            config: {},
          },
          {
            id: 'node-cmd-1',
            type: 'command',
            category: 'task',
            title: 'Shell Script',
            x: 0,
            y: 0,
            inputs: [],
            outputs: [],
            config: {},
          },
          conditionNode,
        ],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      });
    });

    it('renders target node and field picker in node mode and formats token', () => {
      fixture.componentRef.setInput('node', conditionNode);
      fixture.componentRef.setInput('nodeConfig', {
        operator: 'equals',
        leftMode: 'node',
        leftNodeId: 'node-sync-1',
        leftField: 'status',
        leftValue: '{{nodes.node-sync-1.status}}',
        rightValue: 'completed',
      });
      fixture.detectChanges();

      expect(component.isUnaryConditionOperator()).toBe(false);
      expect(component.isFileExistsConditionOperator()).toBe(false);
      expect(component.conditionLeftValueMode()).toBe('node');
      expect(component.availableUpstreamNodes().length).toBe(2);
      expect(component.conditionTargetNodeId()).toBe('node-sync-1');
      expect(component.conditionTargetField()).toBe('status');

      // Check fields for sync node
      const syncFields = component.availableNodeFields();
      expect(syncFields.some(f => f.key === 'bytesTransferred')).toBe(true);

      const emitted: { key: string; value: unknown }[] = [];
      component.configChange.subscribe(val => emitted.push(val));

      component.onConditionTargetNodeChange('node-cmd-1');
      expect(emitted).toContainEqual({ key: 'leftNodeId', value: 'node-cmd-1' });
      expect(emitted).toContainEqual({
        key: 'leftValue',
        value: '{{nodes.node-cmd-1.exitCode}}',
      });

      fixture.componentRef.setInput('nodeConfig', {
        operator: 'equals',
        leftMode: 'node',
        leftNodeId: 'node-cmd-1',
        leftField: 'exitCode',
        leftValue: '{{nodes.node-cmd-1.exitCode}}',
      });
      fixture.detectChanges();

      component.onConditionTargetFieldChange('stdout');
      expect(emitted).toContainEqual({ key: 'leftField', value: 'stdout' });
      expect(emitted).toContainEqual({
        key: 'leftValue',
        value: '{{nodes.node-cmd-1.stdout}}',
      });
    });

    it('handles switching to custom mode and back', () => {
      fixture.componentRef.setInput('node', conditionNode);
      fixture.componentRef.setInput('nodeConfig', {
        operator: 'equals',
        leftMode: 'custom',
        leftValue: 'custom-val',
        rightValue: 'bar',
      });
      fixture.detectChanges();

      expect(component.conditionLeftValueMode()).toBe('custom');

      const emitted: { key: string; value: unknown }[] = [];
      component.configChange.subscribe(val => emitted.push(val));

      component.setConditionLeftValueMode('node');
      expect(emitted).toContainEqual({ key: 'leftMode', value: 'node' });
      expect(emitted).toContainEqual({ key: 'leftNodeId', value: 'node-sync-1' });
    });

    it('hides right value input for unary operators and adjusts operator state', () => {
      fixture.componentRef.setInput('node', conditionNode);
      fixture.componentRef.setInput('nodeConfig', {
        operator: 'file_exists',
        leftMode: 'custom',
        leftValue: '/tmp/test.txt',
      });
      fixture.detectChanges();

      expect(component.isUnaryConditionOperator()).toBe(true);
      expect(component.isFileExistsConditionOperator()).toBe(true);

      const compiled = fixture.nativeElement as HTMLElement;
      const inputs = compiled.querySelectorAll('input');
      // Only leftValue input should be present (rightValue is hidden)
      expect(inputs.length).toBe(1);
    });

    it('emits changes when condition fields are updated', () => {
      fixture.componentRef.setInput('node', conditionNode);
      fixture.componentRef.setInput('nodeConfig', { operator: 'equals' });
      fixture.detectChanges();

      const emitted: { key: string; value: unknown }[] = [];
      component.configChange.subscribe(val => emitted.push(val));

      component.onFieldChange('operator', 'contains');
      component.onFieldChange('leftValue', '{{nodes.task1.status}}');
      component.onFieldChange('rightValue', 'success');

      expect(emitted).toEqual([
        { key: 'operator', value: 'contains' },
        { key: 'leftValue', value: '{{nodes.task1.status}}' },
        { key: 'rightValue', value: 'success' },
      ]);
    });
  });
});
