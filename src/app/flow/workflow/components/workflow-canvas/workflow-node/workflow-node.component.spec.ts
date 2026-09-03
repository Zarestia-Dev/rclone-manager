import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { WorkflowNodeComponent } from './workflow-node.component';
import { WorkflowNode } from '../../../types/workflow.types';
import { provideTranslateService } from '@ngx-translate/core';
import { WorkflowStateService } from '../../../../../services/flow/workflow-state.service';
import { MountManagementService } from '../../../../../services/operations/mount-management.service';
import { MountedRemote } from '../../../../../shared/types/remotes';

describe('WorkflowNodeComponent', () => {
  let fixture: ComponentFixture<WorkflowNodeComponent>;
  let component: WorkflowNodeComponent;
  let mountedRemotesSignal: ReturnType<typeof signal<MountedRemote[]>>;

  const mockNode: WorkflowNode = {
    id: 'node-sync-1',
    type: 'sync',
    category: 'task',
    title: 'Daily Sync',
    subtitle: 'Local to GDrive',
    x: 100,
    y: 150,
    inputs: [{ id: 'in', name: 'In', type: 'in', label: 'In' }],
    outputs: [
      { id: 'success', name: 'Success', type: 'success', label: 'Success' },
      { id: 'failure', name: 'Failure', type: 'failure', label: 'Failure' },
    ],
    config: { remote: 'gdrive' },
    state: 'idle',
  };

  beforeEach(async () => {
    mountedRemotesSignal = signal<MountedRemote[]>([]);

    await TestBed.configureTestingModule({
      imports: [WorkflowNodeComponent],
      providers: [
        provideTranslateService(),
        WorkflowStateService,
        {
          provide: MountManagementService,
          useValue: {
            mountedRemotes: mountedRemotesSignal,
            unmountRemote: vi.fn(),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(WorkflowNodeComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('node', mockNode);
    fixture.detectChanges();
  });

  it('renders title, subtitle, and category pill', () => {
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.node-title')?.textContent).toContain('Daily Sync');
    expect(el.querySelector('.node-subtitle')?.textContent).toContain('Local to GDrive');
    expect(component.categoryPillClass()).toBe('p-primary');
  });

  it('emits select on card click', () => {
    const spy = vi.fn();
    component.selectNode.subscribe(spy);

    const card = fixture.nativeElement.querySelector('.workflow-node-card');
    card.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(spy).toHaveBeenCalledWith('node-sync-1');
  });

  it('emits delete when delete button is clicked', () => {
    const spy = vi.fn();
    component.deleteNode.subscribe(spy);

    const deleteBtn = fixture.nativeElement.querySelector('.action-btn.danger');
    deleteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(spy).toHaveBeenCalledWith('node-sync-1');
  });

  it('computes portRows and renders port slots correctly', () => {
    const rows = component.portRows();
    expect(rows.length).toBe(2);
    expect(rows[0].inputPort?.id).toBe('in');
    expect(rows[0].outputPort?.id).toBe('success');
    expect(rows[1].inputPort).toBeUndefined();
    expect(rows[1].outputPort?.id).toBe('failure');

    const el: HTMLElement = fixture.nativeElement;
    const portRowsEl = el.querySelectorAll('.node-ports .port-row');
    expect(portRowsEl.length).toBe(2);
  });

  it('detects live mounted status for active mount nodes', () => {
    const mountNode: WorkflowNode = {
      id: 'node-mount-1',
      type: 'mount',
      category: 'task',
      title: 'Mount Remote',
      x: 100,
      y: 150,
      inputs: [],
      outputs: [],
      config: { remote: 'gdrive', mountPoint: '/mnt/gdrive' },
    };

    fixture.componentRef.setInput('node', mountNode);
    fixture.detectChanges();

    expect(component.isLiveActive()).toBe(false);
  });

  it('activates live mounted status only when workflow_id and node_id match exactly', () => {
    const stateService = TestBed.inject(WorkflowStateService);

    stateService.createNewWorkflow('Live Test Flow');
    const currentWf = stateService.currentWorkflow();
    const wfId = currentWf ? currentWf.id : 'test-wf';

    const mountNode: WorkflowNode = {
      id: 'node-mount-exact',
      type: 'mount',
      category: 'task',
      title: 'Mount Remote',
      x: 100,
      y: 150,
      inputs: [],
      outputs: [],
      config: { remote: 'gdrive', mountPoint: '/mnt/gdrive' },
    };

    fixture.componentRef.setInput('node', mountNode);
    fixture.detectChanges();

    // 1. Outside mount matching path and fs, but with different or missing workflow_id
    // This previously caused false positives!
    mountedRemotesSignal.set([
      {
        fs: 'gdrive:',
        mount_point: '/mnt/gdrive',
        workflow_id: 'other-workflow-id',
        node_id: 'other-node-id',
      },
    ]);
    fixture.detectChanges();
    expect(component.isLiveMounted()).toBe(false);
    expect(component.isLiveActive()).toBe(false);

    // 2. Exact match on workflow_id and node_id
    mountedRemotesSignal.set([
      {
        fs: 'gdrive:',
        mount_point: '/mnt/gdrive',
        workflow_id: wfId,
        node_id: 'node-mount-exact',
      },
    ]);
    fixture.detectChanges();
    expect(component.isLiveMounted()).toBe(true);
    expect(component.isLiveActive()).toBe(true);
    expect(component.liveStatusLabelKey()).toBe('flow.workflow.liveStatus.mounted');
  });

  it('computes notification node icon based on actionKind', () => {
    const notifNode: WorkflowNode = {
      id: 'node-notif-1',
      type: 'notification',
      category: 'action',
      title: 'Send Notification',
      x: 0,
      y: 0,
      inputs: [],
      outputs: [],
      config: { actionKind: 'whatsapp' },
    };

    fixture.componentRef.setInput('node', notifNode);
    fixture.detectChanges();
    expect(component.nodeIcon()).toBe('whatsapp');

    const telegramNode: WorkflowNode = {
      ...notifNode,
      config: { actionKind: 'telegram' },
    };
    fixture.componentRef.setInput('node', telegramNode);
    fixture.detectChanges();
    expect(component.nodeIcon()).toBe('telegram');
  });

  it('computes displaySubtitle for cron node without explicit subtitle', () => {
    const cronNode: WorkflowNode = {
      id: 'node-cron-1',
      type: 'cron',
      category: 'trigger',
      title: 'Cron Schedule',
      x: 0,
      y: 0,
      inputs: [],
      outputs: [],
      config: { cronExpression: '0 2 * * *' },
    };

    fixture.componentRef.setInput('node', cronNode);
    fixture.detectChanges();
    expect(component.displaySubtitle()).toContain('2:00 AM');
  });
});
