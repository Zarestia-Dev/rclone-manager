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

  it('computes delaySecondsValue correctly with delaySeconds key', () => {
    expect(component.delaySecondsValue()).toBe(5);

    fixture.componentRef.setInput('nodeConfig', { delaySeconds: 20 });
    fixture.detectChanges();
    expect(component.delaySecondsValue()).toBe(20);

    fixture.componentRef.setInput('nodeConfig', { delaySeconds: '45' });
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

    // emit joinMode change
    let emitted: { key: string; value: unknown } | null = null;
    component.configChange.subscribe(val => {
      emitted = val;
    });
    component.onFieldChange('joinMode', 'any_success');
    expect(emitted).toEqual({ key: 'joinMode', value: 'any_success' });

    const nodeWith3Inputs: WorkflowNode = {
      ...joinNode,
      inputs: [...joinNode.inputs, { id: 'in3', name: 'In 3', type: 'in' }],
    };
    fixture.componentRef.setInput('node', nodeWith3Inputs);
    fixture.detectChanges();

    // Call add and remove methods
    component.addInputBranch();
    component.removeInputBranch('in3');
  });

  it('handles parallel_fork node branch additions and removals', () => {
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

    const nodeWith3Outputs: WorkflowNode = {
      ...forkNode,
      outputs: [...forkNode.outputs, { id: 'branch3', name: 'Branch 3', type: 'out' }],
    };
    fixture.componentRef.setInput('node', nodeWith3Outputs);
    fixture.detectChanges();

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
        // Both tasks lead into the condition, so both are upstream of it.
        edges: [
          {
            id: 'e-sync',
            sourceNodeId: 'node-sync-1',
            sourcePortId: 'success',
            targetNodeId: conditionNode.id,
            targetPortId: 'in',
          },
          {
            id: 'e-cmd',
            sourceNodeId: 'node-cmd-1',
            sourcePortId: 'success',
            targetNodeId: conditionNode.id,
            targetPortId: 'in',
          },
        ],
        viewport: { x: 0, y: 0, zoom: 1 },
        showOnTray: false,
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
      expect(component.availableUpstreamNodes().length).toBe(3);
      expect(component.availableUpstreamNodes().some(n => n.id === 'prev')).toBe(true);
      expect(component.conditionTargetNodeId()).toBe('node-sync-1');
      expect(component.conditionTargetField()).toBe('status');

      // Check fields for sync node
      const syncFields = component.availableNodeFields();
      expect(syncFields.some(f => f.key === 'bytesFormatted')).toBe(true);

      const patches: Record<string, unknown>[] = [];
      component.configPatch.subscribe(patch => patches.push(patch));

      component.onConditionTargetNodeChange('node-cmd-1');
      expect(patches.pop()).toEqual({
        leftNodeId: 'node-cmd-1',
        leftField: 'summary',
        leftValue: '{{nodes.node-cmd-1.summary}}',
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
      expect(patches.pop()).toEqual({
        leftNodeId: 'node-cmd-1',
        leftField: 'stdout',
        leftValue: '{{nodes.node-cmd-1.stdout}}',
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

      const patches: Record<string, unknown>[] = [];
      const changes: { key: string; value: unknown }[] = [];
      component.configPatch.subscribe(patch => patches.push(patch));
      component.configChange.subscribe(change => changes.push(change));

      component.setConditionLeftValueMode('node');
      expect(patches.pop()).toMatchObject({ leftMode: 'node', leftNodeId: 'prev' });

      component.setConditionLeftValueMode('custom');
      expect(changes).toEqual([{ key: 'leftMode', value: 'custom' }]);
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

    it('applies condition presets correctly', () => {
      fixture.componentRef.setInput('node', conditionNode);
      fixture.componentRef.setInput('nodeConfig', { operator: 'equals' });
      fixture.detectChanges();

      const patches: Record<string, unknown>[] = [];
      component.configPatch.subscribe(patch => patches.push(patch));

      // A preset is one change, so one undo step
      component.applyConditionPreset('has_diff');
      expect(patches).toEqual([
        {
          leftMode: 'node',
          leftNodeId: 'prev',
          leftField: 'hasDifferences',
          leftValue: '{{prev.hasDifferences}}',
          operator: 'equals',
          rightValue: 'true',
        },
      ]);

      component.applyConditionPreset('diff_count');
      expect(patches.pop()).toMatchObject({
        leftField: 'differCount',
        operator: 'greater_than',
        rightValue: '0',
      });

      // 3. Array unary operator check
      fixture.componentRef.setInput('nodeConfig', { operator: 'array_not_empty' });
      fixture.detectChanges();
      expect(component.isUnaryConditionOperator()).toBe(true);
    });
  });

  describe('schedule_wait node', () => {
    const scheduleWaitNode: WorkflowNode = {
      id: 'node-wait-1',
      type: 'schedule_wait',
      category: 'logic',
      title: 'Schedule Wait',
      x: 0,
      y: 0,
      inputs: [{ id: 'in', name: 'In', type: 'in' }],
      outputs: [{ id: 'out', name: 'Out', type: 'out' }],
      config: { cronExpression: '0 2 * * *' },
    };

    it('computes cron validity and readable format for schedule_wait', () => {
      fixture.componentRef.setInput('node', scheduleWaitNode);
      fixture.componentRef.setInput('nodeConfig', { cronExpression: '0 2 * * *' });
      fixture.detectChanges();

      expect(component.isCronInvalid()).toBe(false);
      expect(component.cronHumanReadable()).toBeTruthy();

      // invalid cron test
      fixture.componentRef.setInput('nodeConfig', { cronExpression: 'invalid-cron-format' });
      fixture.detectChanges();
      expect(component.isCronInvalid()).toBe(true);
    });

    it('emits openDetailed when openDetailed is triggered', () => {
      fixture.componentRef.setInput('node', scheduleWaitNode);
      fixture.detectChanges();

      let emitted = false;
      component.openDetailed.subscribe(() => {
        emitted = true;
      });

      component.openDetailed.emit();
      expect(emitted).toBe(true);
    });
  });
});
