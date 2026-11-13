import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { WorkflowNodeComponent } from './workflow-node.component';
import { WorkflowNode } from '../../../types/workflow.types';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { WorkflowStateService } from '../../../../../services/flow/workflow-state.service';
import { MountManagementService } from '../../../../../services/operations/mount-management.service';
import { JobManagementService } from '../../../../../services/operations/job-management.service';
import { ModalService } from '../../../../../services/ui/modal.service';
import { MountedRemote } from '../../../../../shared/types/remotes';
import { JobInfo } from '@app/types';
import {
  WorkflowNodeLayoutService,
  portKey,
} from '../../../../../services/flow/workflow-node-layout.service';

describe('WorkflowNodeComponent', () => {
  let fixture: ComponentFixture<WorkflowNodeComponent>;
  let component: WorkflowNodeComponent;
  let mountedRemotesSignal: ReturnType<typeof signal<MountedRemote[]>>;
  let mockJobService: { getLatestJobForWorkflowNode: ReturnType<typeof vi.fn> };
  let mockModalService: { openJobDetail: ReturnType<typeof vi.fn> };

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
    mockJobService = {
      getLatestJobForWorkflowNode: vi.fn().mockReturnValue(null),
    };
    mockModalService = {
      openJobDetail: vi.fn(),
    };

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
        {
          provide: JobManagementService,
          useValue: mockJobService,
        },
        {
          provide: ModalService,
          useValue: mockModalService,
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
    expect(el.querySelector<HTMLElement>('.node-category-wrapper [appPill]')?.dataset['tone']).toBe(
      'primary'
    );
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

    const deleteBtn = fixture.nativeElement.querySelector('.action-button.danger');
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
        starter: {
          kind: 'workflow',
          workflowId: 'other-workflow-id',
          workflowName: 'Workflow',
          nodeId: 'other-node-id',
          ancestors: [],
        },
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
        starter: {
          kind: 'workflow',
          workflowId: wfId,
          workflowName: 'Workflow',
          nodeId: 'node-mount-exact',
          ancestors: [],
        },
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

  it('shows what a notification says as its subtitle, unless it has one of its own', () => {
    const notify: WorkflowNode = {
      ...mockNode,
      id: 'node-notify-1',
      type: 'notification',
      category: 'action',
      subtitle: undefined,
      config: { title: 'Backup Complete' },
    };
    fixture.componentRef.setInput('node', notify);
    fixture.detectChanges();
    expect(component.displaySubtitle()).toBe('Backup Complete');

    fixture.componentRef.setInput('node', { ...notify, subtitle: 'Own line' });
    fixture.detectChanges();
    expect(component.displaySubtitle()).toBe('Own line');
  });

  it('detects nodeJob and opens job detail when inspect job button is clicked', () => {
    const stateService = TestBed.inject(WorkflowStateService);
    stateService.createNewWorkflow('Job Test');
    const wfId = stateService.currentWorkflow()?.id ?? 'wf-1';

    const mockJob: JobInfo = {
      jobid: 42,
      execute_id: 'exec-42',
      job_type: 'sync',
      source: '/local',
      destination: 'remote:dest',
      start_time: '2026-09-10T12:00:00Z',
      status: 'Running',
      remote_name: 'remote',
      stats: {
        bytes: 100,
        totalBytes: 500,
        speed: 50,
        eta: 10,
        transfers: 1,
        totalTransfers: 5,
        errors: 0,
        checks: 0,
        totalChecks: 0,
        deletedDirs: 0,
        deletes: 0,
        renames: 0,
        serverSideCopies: 0,
        serverSideMoves: 0,
        elapsedTime: 10,
        lastError: '',
        fatalError: false,
        retryError: false,
        serverSideCopyBytes: 0,
        serverSideMoveBytes: 0,
        transferTime: 10,
        transferring: [],
        listed: 0,
        completed: [],
      },
      starter: {
        kind: 'workflow',
        workflowId: wfId,
        workflowName: 'Workflow',
        nodeId: mockNode.id,
        ancestors: [],
      },
    };

    mockJobService.getLatestJobForWorkflowNode.mockReturnValue(mockJob);
    fixture.detectChanges();

    expect(component.nodeJob()).toEqual(mockJob);

    const jobBtn = fixture.nativeElement.querySelector('.action-button.job-btn');
    expect(jobBtn).toBeTruthy();
    expect(jobBtn.classList.contains('is-running')).toBe(true);

    jobBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(mockModalService.openJobDetail).toHaveBeenCalledWith(mockJob);
  });

  it('opens job detail modal when execution badge with job is clicked', () => {
    const stateService = TestBed.inject(WorkflowStateService);
    stateService.createNewWorkflow('Badge Job Test');
    const wfId = stateService.currentWorkflow()?.id ?? 'wf-1';

    const mockJob: JobInfo = {
      jobid: 99,
      execute_id: 'exec-99',
      job_type: 'copy',
      source: '/src',
      destination: 'dest:',
      start_time: '2026-09-10T12:00:00Z',
      status: 'Completed',
      remote_name: 'remote',
      stats: {
        bytes: 500,
        totalBytes: 500,
        speed: 0,
        eta: 0,
        transfers: 5,
        totalTransfers: 5,
        errors: 0,
        checks: 0,
        totalChecks: 0,
        deletedDirs: 0,
        deletes: 0,
        renames: 0,
        serverSideCopies: 0,
        serverSideMoves: 0,
        elapsedTime: 12,
        lastError: '',
        fatalError: false,
        retryError: false,
        serverSideCopyBytes: 0,
        serverSideMoveBytes: 0,
        transferTime: 12,
        transferring: [],
        listed: 0,
        completed: [],
      },
      starter: {
        kind: 'workflow',
        workflowId: wfId,
        workflowName: 'Workflow',
        nodeId: mockNode.id,
        ancestors: [],
      },
    };

    mockJobService.getLatestJobForWorkflowNode.mockReturnValue(mockJob);
    fixture.componentRef.setInput('node', { ...mockNode, state: 'success' });
    fixture.detectChanges();

    const badge = fixture.nativeElement.querySelector('.node-execution-badge');
    expect(badge).toBeTruthy();
    expect(badge.classList.contains('has-job')).toBe(true);

    badge.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(mockModalService.openJobDetail).toHaveBeenCalledWith(mockJob);
  });

  it('marks every port handle with the ids the canvas needs to wire it', () => {
    const inputHandle = fixture.nativeElement.querySelector('.input-handle') as HTMLElement;
    const outputHandles = fixture.nativeElement.querySelectorAll('.output-handle');

    expect(inputHandle.dataset['nodeId']).toBe(mockNode.id);
    expect(inputHandle.dataset['portId']).toBe('in');
    expect(inputHandle.dataset['isOutput']).toBe('false');
    expect((outputHandles[0] as HTMLElement).dataset['portId']).toBe('success');
    expect((outputHandles[0] as HTMLElement).dataset['isOutput']).toBe('true');
    expect((outputHandles[1] as HTMLElement).dataset['portId']).toBe('failure');
  });

  it('renders dynamic title when titleKey is set', () => {
    const nodeWithKey: WorkflowNode = {
      ...mockNode,
      titleKey: 'flow.workflow.nodes.manualTrigger',
      title: 'Manual Trigger',
    };
    fixture.componentRef.setInput('node', nodeWithKey);
    fixture.detectChanges();
    expect(component.displayTitle()).toBe('flow.workflow.nodes.manualTrigger');
  });

  it('shows the error of a failed step translated', () => {
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', {
      backendErrors: { workflow: { jobStopped: 'Job {{id}} was stopped' } },
    });
    translate.use('en');
    fixture.componentRef.setInput('node', {
      ...mockNode,
      state: 'failed',
      errorMessage: '{"key":"backendErrors.workflow.jobStopped","params":{"id":"7"}}',
    });
    fixture.detectChanges();

    const shown = fixture.nativeElement.querySelector('.node-error-message');
    expect(shown?.textContent).toContain('Job 7 was stopped');
    expect(shown?.getAttribute('title')).toBe('Job 7 was stopped');
  });

  it('emits inspectNode when inspect button is clicked', () => {
    const inspectSpy = vi.fn();
    component.inspectNode.subscribe(inspectSpy);

    const actionButtons = fixture.nativeElement.querySelectorAll('.node-actions .action-button');
    // Inspect button has svgIcon="gear"
    let inspectBtn: HTMLElement | null = null;
    for (const btn of Array.from(actionButtons) as HTMLElement[]) {
      if (btn.querySelector('mat-icon[svgIcon="gear"]')) {
        inspectBtn = btn;
        break;
      }
    }
    expect(inspectBtn).toBeTruthy();
    inspectBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(inspectSpy).toHaveBeenCalledWith(mockNode.id);
  });

  it('does not look up jobs again when the workflow changes but keeps its id', () => {
    const stateService = TestBed.inject(WorkflowStateService);
    stateService.createNewWorkflow('Lookup');
    const other = stateService.addNode('sync', 'task', 'Other', 0, 0);
    fixture.detectChanges();
    mockJobService.getLatestJobForWorkflowNode.mockClear();

    stateService.updateNodesPositions(new Map([[other.id, { x: 160, y: 80 }]]));
    fixture.detectChanges();

    expect(mockJobService.getLatestJobForWorkflowNode).not.toHaveBeenCalled();
  });

  describe('measured layout', () => {
    const rect = (left: number, top: number, width: number, height: number): DOMRect =>
      ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;

    /** Lays the card out at the given zoom, 100px from the left of the page and 40px from the top. */
    function layOut(zoom: number, portOffsetY: number): void {
      const el: HTMLElement = fixture.nativeElement;
      const card = el.querySelector<HTMLElement>('.workflow-node-card') as HTMLElement;
      Object.defineProperty(card, 'offsetWidth', { value: 240, configurable: true });
      Object.defineProperty(card, 'offsetHeight', { value: 130, configurable: true });
      vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(
        rect(100, 40, 240 * zoom, 130 * zoom)
      );

      const handles: Record<string, { x: number; y: number }> = {
        'in:in': { x: 0, y: portOffsetY },
        'out:success': { x: 240, y: portOffsetY },
        'out:failure': { x: 240, y: portOffsetY + 28 },
      };
      for (const handle of Array.from(el.querySelectorAll<HTMLElement>('.port-handle'))) {
        const key = portKey(handle.dataset['portId'] ?? '', handle.dataset['isOutput'] === 'true');
        const at = handles[key];
        // A 14px handle, centred on `at`, drawn at the zoom.
        vi.spyOn(handle, 'getBoundingClientRect').mockReturnValue(
          rect(100 + (at.x - 7) * zoom, 40 + (at.y - 7) * zoom, 14 * zoom, 14 * zoom)
        );
      }
      // The effect measures again when the ports change.
      fixture.componentRef.setInput('node', { ...mockNode, inputs: [...mockNode.inputs] });
      fixture.detectChanges();
    }

    it('reports its size and the centre of every port', () => {
      const layout = TestBed.inject(WorkflowNodeLayoutService);
      layOut(1, 100);
      const measured = layout.layoutOf(mockNode.id);
      expect(measured?.width).toBe(240);
      expect(measured?.height).toBe(130);
      expect(measured?.ports['in:in']).toEqual({ x: 0, y: 100 });
      expect(measured?.ports['out:success']).toEqual({ x: 240, y: 100 });
      expect(measured?.ports['out:failure']).toEqual({ x: 240, y: 128 });
    });

    it('reports canvas units when the canvas is zoomed', () => {
      const layout = TestBed.inject(WorkflowNodeLayoutService);
      layOut(0.5, 104);
      expect(layout.layoutOf(mockNode.id)?.ports['out:failure']).toEqual({ x: 240, y: 132 });
      expect(layout.layoutOf(mockNode.id)?.width).toBe(240);
    });

    it('does not measure again when the node only moves or is updated', () => {
      layOut(1, 100);
      const card = (fixture.nativeElement as HTMLElement).querySelector(
        '.workflow-node-card'
      ) as HTMLElement;
      const measured = vi.mocked(card.getBoundingClientRect);
      measured.mockClear();

      for (let frame = 1; frame <= 5; frame++) {
        fixture.componentRef.setInput('node', { ...component.node(), x: frame * 16, y: frame * 8 });
        fixture.detectChanges();
      }

      expect(measured).not.toHaveBeenCalled();
    });

    it('reports nothing while the card has no layout (hidden tab)', () => {
      const layout = TestBed.inject(WorkflowNodeLayoutService);
      expect(layout.layoutOf(mockNode.id)).toBeUndefined();
    });

    it('forgets its layout when it is removed', () => {
      const layout = TestBed.inject(WorkflowNodeLayoutService);
      layOut(1, 100);
      expect(layout.layoutOf(mockNode.id)).toBeDefined();
      fixture.destroy();
      expect(layout.layoutOf(mockNode.id)).toBeUndefined();
    });
  });
});
