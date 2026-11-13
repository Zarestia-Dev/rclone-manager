import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideTranslateService } from '@ngx-translate/core';
import { ActionNodeFormComponent } from './action-node-form.component';
import { WorkflowNode } from '../../../types/workflow.types';
import { AlertService } from '../../../../../services/alerts/alert.service';
import { ModalService } from '../../../../../services/ui/modal.service';
import { AlertAction } from '@app/types';

describe('ActionNodeFormComponent', () => {
  let fixture: ComponentFixture<ActionNodeFormComponent>;
  let component: ActionNodeFormComponent;
  let modalServiceSpy: { openAlerts: ReturnType<typeof vi.fn> };

  const mockActions: AlertAction[] = [
    {
      id: 'action-telegram-1',
      name: 'Telegram Bot',
      kind: 'telegram',
      enabled: true,
      bot_token: '123',
      chat_id: '456',
      body_template: '',
      timeout_secs: 30,
      retry_count: 0,
    },
  ];

  const mockNode: WorkflowNode = {
    id: 'node-notif-1',
    type: 'notification',
    category: 'action',
    title: 'Notification Node',
    x: 0,
    y: 0,
    inputs: [],
    outputs: [],
    config: { title: 'Alert', severity: 'info' },
  };

  beforeEach(async () => {
    modalServiceSpy = { openAlerts: vi.fn() };

    const mockAlertService = {
      actions: signal<AlertAction[]>(mockActions),
      getTemplateKeys: vi
        .fn()
        .mockResolvedValue([
          'profile',
          'operation',
          'severity',
          'remote',
          'timestamp',
          'title',
          'body',
        ]),
      getActionIcon: (kind?: string): string => {
        switch (kind) {
          case 'telegram':
            return 'telegram';
          case 'webhook':
            return 'webhook';
          default:
            return 'bell';
        }
      },
    };

    await TestBed.configureTestingModule({
      imports: [ActionNodeFormComponent],
      providers: [
        provideTranslateService(),
        { provide: AlertService, useValue: mockAlertService },
        { provide: ModalService, useValue: modalServiceSpy },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ActionNodeFormComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('node', mockNode);
    fixture.componentRef.setInput('nodeConfig', { title: 'Alert', severity: 'info' });
    fixture.detectChanges();
  });

  it('emits configChange when notification title is changed', () => {
    let emitted: { key: string; value: unknown } | null = null;
    component.configChange.subscribe(val => {
      emitted = val;
    });

    component.onFieldChange('title', 'Backup Complete');
    expect(emitted).toEqual({ key: 'title', value: 'Backup Complete' });
  });

  it('emits configChange when severity is changed', () => {
    let emitted: { key: string; value: unknown } | null = null;
    component.configChange.subscribe(val => {
      emitted = val;
    });

    component.onFieldChange('severity', 'critical');
    expect(emitted).toEqual({ key: 'severity', value: 'critical' });
  });

  it('emits actionId, actionKind and icon together when an action is selected', () => {
    const patches: Record<string, unknown>[] = [];
    component.configPatch.subscribe(patch => patches.push(patch));

    component.onActionSelect('action-telegram-1');
    expect(patches).toEqual([
      { actionId: 'action-telegram-1', actionKind: 'telegram', icon: 'telegram' },
    ]);
  });

  it('opens alerts modal when openAlertsModal is called', () => {
    component.openAlertsModal();
    expect(modalServiceSpy.openAlerts).toHaveBeenCalled();
  });

  it('returns valid notification icon from getActionIcon', () => {
    expect(component.getActionIcon('telegram')).toBe('telegram');
    expect(component.getActionIcon('webhook')).toBe('webhook');
    expect(component.getActionIcon('unknown')).toBe('bell');
  });

  it('inserts a variable into the message when insertVariableToken is called', () => {
    let emitted: { key: string; value: unknown } | null = null;
    component.configChange.subscribe(val => {
      emitted = val;
    });

    component.insertVariableToken('profile');
    expect(emitted).toEqual({ key: 'message', value: '{{profile}}' });
  });

  it('returns appropriate action details from getActionDetail', () => {
    expect(component.getActionDetail(mockActions[0])).toBe('456');
    expect(
      component.getActionDetail({
        id: 'w1',
        name: 'Hook',
        kind: 'webhook',
        enabled: true,
        url: 'https://example.com',
        method: 'POST',
        headers: {},
        body_template: '',
        timeout_secs: 10,
        tls_verify: true,
        retry_count: 0,
      })
    ).toBe('POST https://example.com');
  });

  it('computes unmount target mode correctly and toggles mode', () => {
    const unmountNode: WorkflowNode = {
      id: 'node-unmount-1',
      type: 'unmount',
      category: 'action',
      title: 'Unmount Remote',
      x: 0,
      y: 0,
      inputs: [],
      outputs: [],
      config: { targetNodeId: 'node-mount-1' },
    };
    fixture.componentRef.setInput('node', unmountNode);
    fixture.componentRef.setInput('nodeConfig', { targetNodeId: 'node-mount-1' });
    fixture.componentRef.setInput('availableMountNodes', [
      {
        id: 'node-mount-1',
        title: 'Mount 1',
        type: 'mount',
        category: 'task',
        x: 0,
        y: 0,
        inputs: [],
        outputs: [],
      },
    ]);
    fixture.detectChanges();

    expect(component.unmountTargetMode()).toBe('node');

    const patches: Record<string, unknown>[] = [];
    component.configPatch.subscribe(patch => patches.push(patch));

    // Switch to custom mode: one step
    component.setUnmountTargetMode('custom');
    expect(patches.pop()).toEqual({ targetMode: 'custom', targetNodeId: '' });

    // Switch to node mode: the typed target goes, a node is already chosen
    component.setUnmountTargetMode('node');
    expect(patches.pop()).toEqual({ targetMode: 'node', mountPoint: '' });

    // Without a chosen node, the first one is picked
    fixture.componentRef.setInput('nodeConfig', { mountPoint: '/mnt/x' });
    fixture.detectChanges();
    component.setUnmountTargetMode('node');
    expect(patches.pop()).toEqual({
      targetMode: 'node',
      mountPoint: '',
      targetNodeId: 'node-mount-1',
    });
  });

  it('computes stop_serve target mode correctly and toggles mode', () => {
    const stopServeNode: WorkflowNode = {
      id: 'node-stop-serve-1',
      type: 'stop_serve',
      category: 'action',
      title: 'Stop Serve',
      x: 0,
      y: 0,
      inputs: [],
      outputs: [],
      config: { serverId: '12345' },
    };
    fixture.componentRef.setInput('node', stopServeNode);
    fixture.componentRef.setInput('nodeConfig', { serverId: '12345' });
    fixture.componentRef.setInput('availableServeNodes', [
      {
        id: 'node-serve-1',
        title: 'Serve 1',
        type: 'serve',
        category: 'task',
        x: 0,
        y: 0,
        inputs: [],
        outputs: [],
      },
    ]);
    fixture.detectChanges();

    expect(component.stopServeTargetMode()).toBe('custom');

    const patches: Record<string, unknown>[] = [];
    component.configPatch.subscribe(patch => patches.push(patch));

    // Switch to node mode: the typed server goes, the first node is picked
    component.setStopServeTargetMode('node');
    expect(patches.pop()).toEqual({
      targetMode: 'node',
      serverId: '',
      targetNodeId: 'node-serve-1',
    });

    // Switch to custom mode
    component.setStopServeTargetMode('custom');
    expect(patches.pop()).toEqual({ targetMode: 'custom', targetNodeId: '' });
  });

  it('applies a notification preset as one change, in the language of the interface', () => {
    const patches: Record<string, unknown>[] = [];
    component.configPatch.subscribe(patch => patches.push(patch));

    component.applyNotificationPreset('check_report');
    component.applyNotificationPreset('failure_alert');

    expect(patches).toEqual([
      {
        title: 'flow.workflow.inspector.presets.checkReportTitle',
        message: 'flow.workflow.inspector.presets.checkReportMsg',
        severity: 'warning',
      },
      {
        title: 'flow.workflow.inspector.presets.failureAlertTitle',
        message: 'flow.workflow.inspector.presets.failureAlertMsg',
        severity: 'error',
      },
    ]);
  });

  describe('message preview', () => {
    it('shows only what a run produced and leaves any other token as it is', () => {
      fixture.componentRef.setInput('nodeConfig', {
        message: 'Moved {{prev.bytesFormatted}}, {{prev.summary}}, {{nodes.missing.status}}',
      });
      fixture.detectChanges();

      expect(component.previewMessage()).toBe(
        'Moved {{prev.bytesFormatted}}, {{prev.summary}}, {{nodes.missing.status}}'
      );
    });
  });
});
