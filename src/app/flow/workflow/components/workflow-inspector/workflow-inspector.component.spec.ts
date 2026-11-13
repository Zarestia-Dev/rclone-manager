import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { WorkflowInspectorComponent } from './workflow-inspector.component';
import { WorkflowStateService } from '../../../../services/flow/workflow-state.service';
import { WorkflowStorageService } from '../../../../services/flow/workflow-storage.service';
import { RemoteFacadeService } from '../../../../services/facade/remote-facade.service';
import { provideTranslateService } from '@ngx-translate/core';
import { ModalService } from '../../../../services/ui/modal.service';
import { NotificationService } from '../../../../services/ui/notification.service';
import { MountManagementService } from '../../../../services/operations/mount-management.service';
import { ServeManagementService } from '../../../../services/operations/serve-management.service';
import { JobManagementService } from '../../../../services/operations/job-management.service';
import { AlertService } from '../../../../services/alerts/alert.service';
import { MountedRemote } from '../../../../shared/types/remotes';
import { ServeListItem } from '../../../../shared/types/serve';
import { JobInfo } from '@app/types';

describe('WorkflowInspectorComponent', () => {
  let fixture: ComponentFixture<WorkflowInspectorComponent>;
  let component: WorkflowInspectorComponent;
  let stateService: WorkflowStateService;
  let modalServiceSpy: {
    openWorkflowNodeEditor: ReturnType<typeof vi.fn>;
    openJobDetail: ReturnType<typeof vi.fn>;
  };
  let jobServiceSpy: {
    jobs: ReturnType<typeof signal<JobInfo[]>>;
    getLatestJobForWorkflowNode: ReturnType<typeof vi.fn>;
  };
  let storageServiceSpy: {
    saveWorkflow: ReturnType<typeof vi.fn>;
    duplicateWorkflow: ReturnType<typeof vi.fn>;
    deleteWorkflow: ReturnType<typeof vi.fn>;
    workflows: ReturnType<typeof vi.fn>;
    saveShowOnTray: ReturnType<typeof vi.fn>;
    validateWorkflow: ReturnType<typeof vi.fn>;
  };
  let notificationServiceSpy: {
    showSuccess: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    confirmModal: ReturnType<typeof vi.fn>;
  };
  let mountedRemotesSignal: ReturnType<typeof signal<MountedRemote[]>>;
  let runningServesSignal: ReturnType<typeof signal<ServeListItem[]>>;
  let visibleRemotes: ReturnType<typeof signal<{ name: string; type: string }[]>>;

  beforeEach(async () => {
    visibleRemotes = signal([{ name: 'drive', type: 'drive' }]);
    modalServiceSpy = {
      openWorkflowNodeEditor: vi.fn(),
      openJobDetail: vi.fn(),
    };
    jobServiceSpy = {
      jobs: signal<JobInfo[]>([]),
      getLatestJobForWorkflowNode: vi.fn().mockReturnValue(null),
    };
    storageServiceSpy = {
      saveWorkflow: vi.fn().mockResolvedValue({}),
      duplicateWorkflow: vi
        .fn()
        .mockResolvedValue({ id: 'wf-2', name: 'Inspector Test (Copy)', nodes: [], edges: [] }),
      deleteWorkflow: vi.fn().mockResolvedValue(undefined),
      workflows: vi.fn().mockReturnValue([]),
      saveShowOnTray: vi.fn().mockResolvedValue(true),
      validateWorkflow: vi.fn().mockResolvedValue({ errors: [], warnings: [] }),
    };
    notificationServiceSpy = {
      showSuccess: vi.fn(),
      showError: vi.fn(),
      confirmModal: vi.fn().mockResolvedValue(true),
    };
    mountedRemotesSignal = signal<MountedRemote[]>([]);
    runningServesSignal = signal<ServeListItem[]>([]);

    await TestBed.configureTestingModule({
      imports: [WorkflowInspectorComponent],
      providers: [
        provideTranslateService(),
        WorkflowStateService,
        {
          provide: AlertService,
          useValue: {
            actions: signal([]),
            getActionIcon: (): string => 'bell',
            getTemplateKeys: async (): Promise<string[]> => ['title', 'body', 'severity'],
          },
        },
        {
          provide: RemoteFacadeService,
          useValue: { orderedVisibleRemotes: visibleRemotes },
        },
        {
          provide: ModalService,
          useValue: modalServiceSpy,
        },
        {
          provide: JobManagementService,
          useValue: jobServiceSpy,
        },
        {
          provide: WorkflowStorageService,
          useValue: storageServiceSpy,
        },
        {
          provide: NotificationService,
          useValue: notificationServiceSpy,
        },
        {
          provide: MountManagementService,
          useValue: {
            mountedRemotes: mountedRemotesSignal,
            unmountRemote: vi.fn(),
          },
        },
        {
          provide: ServeManagementService,
          useValue: {
            runningServes: runningServesSignal,
            stopServe: vi.fn(),
          },
        },
      ],
    }).compileComponents();

    stateService = TestBed.inject(WorkflowStateService);
    stateService.createNewWorkflow('Inspector Test');
    const node = stateService.addNode('cron', 'trigger', 'My Cron', 0, 0, {
      config: {
        cronExpression: '0 2 * * *',
        options: { transfers: 8 },
        filter_options: { exclude: '*.tmp' },
      },
    });
    stateService.selectNode(node.id);

    fixture = TestBed.createComponent(WorkflowInspectorComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('follows visible remote updates while the inspector stays open', () => {
    visibleRemotes.set([{ name: 'Arşiv & 旅行', type: 's3' }]);
    expect(component.remotes().map(remote => remote.name)).toEqual(['Arşiv & 旅行']);
    visibleRemotes.set([]);
    expect(component.remotes()).toEqual([]);
  });

  it('renders inspector with selected node properties', () => {
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.workflow-inspector-panel')).toBeTruthy();
    expect(component.nodeTitle()).toBe('My Cron');
    expect(component.nodeConfig()['cronExpression']).toBe('0 2 * * *');
  });

  it('updates title when changed in form', () => {
    component.onTitleChange('New Schedule');
    expect(stateService.selectedNode()?.title).toBe('New Schedule');
  });

  it('computes active config entries correctly', () => {
    const entries = component.activeConfigEntries();
    expect(entries.some(e => e.key === 'transfers' && e.value === '8')).toBe(true);
    expect(entries.some(e => e.key === 'exclude' && e.value === '*.tmp')).toBe(true);
  });

  it('does not open modal when node without detailed config is selected', () => {
    const manualNode = stateService.addNode('manual', 'trigger', 'Manual', 0, 0);
    stateService.selectNode(manualNode.id);
    fixture.detectChanges();

    component.openDetailedSettings();
    expect(modalServiceSpy.openWorkflowNodeEditor).not.toHaveBeenCalled();
  });

  it('opens workflow node editor modal for operation nodes', () => {
    const syncNode = stateService.addNode('sync', 'task', 'My Sync', 100, 100, {
      config: { remote: 'drive', srcFs: 'local:/src', dstFs: 'drive:/dst' },
    });
    stateService.selectNode(syncNode.id);
    fixture.detectChanges();

    component.openDetailedSettings();
    expect(modalServiceSpy.openWorkflowNodeEditor).toHaveBeenCalledWith(
      expect.objectContaining({ id: syncNode.id, type: 'sync' })
    );
  });

  it('opens workflow node editor modal for cron node', () => {
    const cronNode = stateService.addNode('cron', 'trigger', 'My Cron', 100, 100, {
      config: { cronExpression: '0 2 * * *' },
    });
    stateService.selectNode(cronNode.id);
    fixture.detectChanges();

    component.openDetailedSettings();
    expect(modalServiceSpy.openWorkflowNodeEditor).toHaveBeenCalledWith(
      expect.objectContaining({ id: cronNode.id, type: 'cron' })
    );
  });

  it('opens workflow node editor modal for rc_command node', () => {
    const rcNode = stateService.addNode('rc_command', 'task', 'My RC', 100, 100, {
      config: { command: 'core/version' },
    });
    stateService.selectNode(rcNode.id);
    fixture.detectChanges();

    component.openDetailedSettings();
    expect(modalServiceSpy.openWorkflowNodeEditor).toHaveBeenCalledWith(
      expect.objectContaining({ id: rcNode.id, type: 'rc_command' })
    );
  });

  it('removes config item on removeConfigItem', () => {
    component.removeConfigItem('options.transfers');
    const updated = stateService.selectedNode();
    expect(updated?.config['options']).toEqual({});
  });

  it('applies config field changes', () => {
    component.onConfigFieldChange('delaySeconds', 15);
    expect(component.nodeConfig()['delaySeconds']).toBe(15);

    component.onConfigFieldChange('command', 'vfs/refresh');
    expect(component.nodeConfig()['command']).toBe('vfs/refresh');
  });

  it('filters availableMountNodes and availableServeNodes correctly', () => {
    const mountNode1 = stateService.addNode('mount', 'task', 'Mount 1', 0, 0, {});
    stateService.addNode('mount', 'task', 'Mount 2', 0, 0, {});
    stateService.addNode('serve', 'task', 'Serve 1', 0, 0, {});
    const unmountNode = stateService.addNode('unmount', 'action', 'Unmount Action', 0, 0, {});

    stateService.selectNode(unmountNode.id);
    fixture.detectChanges();

    const mountNodes = component.availableMountNodes();
    expect(mountNodes.length).toBe(2);
    expect(mountNodes.some(n => n.id === mountNode1.id)).toBe(true);

    const serveNodes = component.availableServeNodes();
    expect(serveNodes.length).toBe(1);
    expect(serveNodes[0].title).toBe('Serve 1');
  });

  it('matches activeMount and activeServe strictly by workflow_id and node_id without false positives', () => {
    const wf = stateService.currentWorkflow();
    const wfId = wf ? wf.id : 'test-wf';
    const mountNode = stateService.addNode('mount', 'task', 'Mount GDrive', 0, 0, {
      config: { remote: 'drive', mountPoint: '/mnt/drive' },
    });

    stateService.selectNode(mountNode.id);
    fixture.detectChanges();

    // 1. Outside mount (same mountPoint & remote, but different workflow_id or no workflow_id)
    mountedRemotesSignal.set([
      {
        fs: 'drive:',
        mount_point: '/mnt/drive',
        starter: {
          kind: 'workflow',
          workflowId: 'other-wf',
          workflowName: 'Workflow',
          nodeId: 'other-node',
          ancestors: [],
        },
      },
    ]);
    fixture.detectChanges();
    // Must NOT match because it belongs to another workflow/node!
    expect(component.activeMount()).toBeNull();

    // 2. Exact match with current workflow_id and node_id
    mountedRemotesSignal.set([
      {
        fs: 'drive:',
        mount_point: '/mnt/drive',
        starter: {
          kind: 'workflow',
          workflowId: wfId,
          workflowName: 'Workflow',
          nodeId: mountNode.id,
          ancestors: [],
        },
      },
    ]);
    fixture.detectChanges();
    expect(component.activeMount()).toBeTruthy();
    expect(component.activeMount()?.mount_point).toBe('/mnt/drive');
  });

  it('renders workflow level inspector when no node is selected', () => {
    stateService.clearSelection();
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.workflow-inspector-panel')).toBeTruthy();
    expect(el.querySelector('.stats-grid')).toBeTruthy();
    expect(component.workflowName()).toBe('Inspector Test');
  });

  it('changes the tray flag without an undo step', () => {
    stateService.clearSelection();
    fixture.detectChanges();
    const undoSteps = stateService.canUndo();

    component.onWorkflowShowOnTrayChange(true);

    expect(stateService.currentWorkflow()?.showOnTray).toBe(true);
    expect(component.workflowShowOnTray()).toBe(true);
    expect(stateService.canUndo()).toBe(undoSteps);
    expect(storageServiceSpy.saveShowOnTray).toHaveBeenCalledWith(
      stateService.currentWorkflow()?.id,
      true
    );
  });

  it('shows the title and subtitle of the selected node as the workflow holds them', () => {
    const node = stateService.addNode('delay', 'logic', 'Wait', 0, 0);
    stateService.selectNode(node.id);
    expect(component.nodeTitle()).toBe('Wait');

    component.onTitleChange('Pause');
    component.onSubtitleChange('ten seconds');

    expect(component.nodeTitle()).toBe('Pause');
    expect(component.nodeSubtitle()).toBe('ten seconds');
  });

  it('updates workflow name and description from inspector', () => {
    stateService.clearSelection();
    fixture.detectChanges();

    component.onWorkflowNameChange('Renamed Flow');
    expect(stateService.currentWorkflow()?.name).toBe('Renamed Flow');

    component.onWorkflowDescriptionChange('New Flow Description');
    expect(stateService.currentWorkflow()?.description).toBe('New Flow Description');
  });

  it('updates notification node icon when actionKind changes', () => {
    const notifNode = stateService.addNode('notification', 'action', 'Notify', 0, 0, {
      config: { title: 'Test' },
    });
    stateService.selectNode(notifNode.id);
    fixture.detectChanges();

    component.onConfigFieldChange('actionKind', 'whatsapp');
    expect(component.nodeIcon()).toBe('whatsapp');
    expect(stateService.selectedNode()?.config['actionKind']).toBe('whatsapp');

    component.onConfigFieldChange('actionKind', 'telegram');
    expect(component.nodeIcon()).toBe('telegram');
    expect(stateService.selectedNode()?.config['actionKind']).toBe('telegram');
  });

  it('detects selectedNodeJob, computes progress, and opens job detail modal', () => {
    const wf = stateService.currentWorkflow();
    const wfId = wf ? wf.id : 'wf-1';
    const syncNode = stateService.addNode('sync', 'task', 'Sync Step', 0, 0, {});
    stateService.selectNode(syncNode.id);

    const mockJob: JobInfo = {
      jobid: 777,
      execute_id: 'exec-777',
      job_type: 'sync',
      source: '/data',
      destination: 'backup:',
      start_time: '2026-09-10T12:00:00Z',
      status: 'Running',
      remote_name: 'backup',
      stats: {
        bytes: 250,
        totalBytes: 1000,
        speed: 125,
        eta: 6,
        transfers: 1,
        totalTransfers: 4,
        errors: 0,
        checks: 0,
        totalChecks: 0,
        deletedDirs: 0,
        deletes: 0,
        renames: 0,
        serverSideCopies: 0,
        serverSideMoves: 0,
        elapsedTime: 2,
        lastError: '',
        fatalError: false,
        retryError: false,
        serverSideCopyBytes: 0,
        serverSideMoveBytes: 0,
        transferTime: 2,
        transferring: [],
        listed: 0,
        completed: [],
      },
      starter: {
        kind: 'workflow',
        workflowId: wfId,
        workflowName: 'Workflow',
        nodeId: syncNode.id,
        ancestors: [],
      },
    };

    jobServiceSpy.getLatestJobForWorkflowNode.mockReturnValue(mockJob);
    fixture.detectChanges();

    expect(component.selectedNodeJob()).toEqual(mockJob);
    expect(component.jobProgressPercent(mockJob)).toBe(25);

    const el: HTMLElement = fixture.nativeElement;
    const jobSection = el.querySelector('.job-detail-section');
    expect(jobSection).toBeTruthy();
    expect(jobSection?.textContent).toContain('#777');
    expect(jobSection?.textContent).toContain('Running');

    const inspectBtn = jobSection?.querySelector('button') as HTMLButtonElement;
    expect(inspectBtn).toBeTruthy();
    inspectBtn.click();

    expect(modalServiceSpy.openJobDetail).toHaveBeenCalledWith(mockJob);
  });

  it('closes inspector panel and clears selection when node is selected', () => {
    const node = stateService.addNode('sync', 'task', 'Sync Node', 10, 10);
    stateService.selectNode(node.id);
    expect(stateService.selectedNode()?.id).toBe(node.id);

    const closeSpy = vi.fn();
    component.closeInspector.subscribe(closeSpy);

    component.closeInspectorPanel();

    expect(stateService.selectedNode()).toBeNull();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('closes inspector panel when no node is selected (workflow details)', () => {
    stateService.clearSelection();
    expect(stateService.selectedNode()).toBeNull();

    const closeSpy = vi.fn();
    component.closeInspector.subscribe(closeSpy);

    component.closeInspectorPanel();

    expect(stateService.selectedNode()).toBeNull();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  describe('checks', () => {
    // The wait is real: the check is debounced by a timer of RxJS, which the fake clock does not drive.
    const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
    const edit = (name: string): void => {
      stateService.setWorkflowName(name);
      fixture.detectChanges();
    };
    const rest = async (): Promise<void> => {
      await wait(600);
      fixture.detectChanges();
    };

    it('shows what the backend finds once the workflow has rested, errors before warnings', async () => {
      stateService.clearSelection();
      storageServiceSpy.validateWorkflow.mockResolvedValue({
        errors: ['Cycle found'],
        warnings: ['Node "Wait" is not connected'],
      });

      edit('Checked');
      await rest();

      const banners = Array.from(
        fixture.nativeElement.querySelectorAll('.checks-list app-alert-banner')
      ) as HTMLElement[];
      expect(banners.map(b => b.className)).toEqual([
        expect.stringContaining('error'),
        expect.stringContaining('warning'),
      ]);
      expect(banners[0].textContent).toContain('Cycle found');
      expect(banners[1].textContent).toContain('is not connected');
    });

    it('folds a long list of warnings behind one button, errors stay in view', async () => {
      stateService.clearSelection();
      storageServiceSpy.validateWorkflow.mockResolvedValue({
        errors: ['Cycle found'],
        warnings: ['a', 'b', 'c', 'd', 'e'],
      });

      edit('Many');
      await rest();

      const banners = (): HTMLElement[] =>
        Array.from(fixture.nativeElement.querySelectorAll('.checks-list app-alert-banner'));
      expect(banners().length).toBe(1);
      const fold = fixture.nativeElement.querySelector('.checks-list button') as HTMLButtonElement;
      expect(fold.textContent).toContain('flow.workflow.inspector.warningsCount');

      fold.click();
      fixture.detectChanges();
      expect(banners().length).toBe(6);
    });

    it('asks once for a burst of edits, and shows nothing when all is well', async () => {
      stateService.clearSelection();
      storageServiceSpy.validateWorkflow.mockClear();

      edit('A');
      await wait(100);
      edit('AB');
      await rest();

      expect(storageServiceSpy.validateWorkflow).toHaveBeenCalledTimes(1);
      expect(fixture.nativeElement.querySelector('.checks-list')).toBeNull();
    });

    it('shows nothing when the backend cannot be asked', async () => {
      stateService.clearSelection();
      storageServiceSpy.validateWorkflow.mockRejectedValue(new Error('offline'));

      edit('Offline');
      await rest();

      expect(component.checks()).toBeNull();
    });
  });

  it('gives every active setting a title with its full key and value, for what is cut short', () => {
    const node = stateService.addNode('sync', 'task', 'Sync', 0, 0, {
      config: {
        config: {
          rclone: {
            remotes: { gdrive: { acknowledge_abuse_of_the_files: true } },
            filter: { includeFrom: '/very/long/path/to/an/include/list.txt' },
          },
        },
      },
    });
    stateService.selectNode(node.id);
    fixture.detectChanges();

    const titles = Array.from(
      fixture.nativeElement.querySelectorAll('.config-chip') as NodeListOf<HTMLElement>
    ).map(chip => chip.title);
    expect(titles).toEqual([
      'includeFrom: /very/long/path/to/an/include/list.txt',
      'gdrive / acknowledge_abuse_of_the_files: true',
    ]);
  });

  describe('result and settings tabs', () => {
    it('shows only the settings for a node that has not run', () => {
      const node = stateService.addNode('sync', 'task', 'Sync', 0, 0, {});
      stateService.selectNode(node.id);
      fixture.detectChanges();

      expect(component.hasResult()).toBe(false);
      expect(component.activeTab()).toBe('settings');
      expect(fixture.nativeElement.querySelector('.inspector-tabs')).toBeNull();
    });

    it('opens on the result of a node that has run and switches to the settings', () => {
      const node = stateService.addNode('sync', 'task', 'Sync', 0, 0, {});
      stateService.updateNode(node.id, { state: 'success', lastOutput: { summary: 'Done' } });
      stateService.selectNode(node.id);
      fixture.detectChanges();

      expect(component.activeTab()).toBe('result');
      expect(fixture.nativeElement.querySelector('.execution-output-section')).toBeTruthy();
      expect(fixture.nativeElement.querySelector('.active-config-section')).toBeNull();

      component.selectTab('settings');
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.execution-output-section')).toBeNull();
      expect(fixture.nativeElement.querySelector('.active-config-section')).toBeTruthy();
    });

    it('forgets the picked tab when another node is selected', () => {
      const first = stateService.addNode('sync', 'task', 'A', 0, 0, {});
      const second = stateService.addNode('copy', 'task', 'B', 0, 0, {});
      stateService.updateNode(first.id, { state: 'success' });
      stateService.updateNode(second.id, { state: 'success' });
      stateService.selectNode(first.id);
      component.selectTab('settings');
      expect(component.activeTab()).toBe('settings');

      stateService.selectNode(second.id);
      expect(component.activeTab()).toBe('result');
    });

    it('keeps the raw output behind a button when a summary or report explains it', () => {
      const node = stateService.addNode('check', 'task', 'Check', 0, 0, {});
      stateService.updateNode(node.id, { state: 'success', lastOutput: { summary: 'Passed' } });
      stateService.selectNode(node.id);

      expect(component.rawOutputVisible()).toBe(false);
      component.rawOutputOpen.set(true);
      expect(component.rawOutputVisible()).toBe(true);
    });

    it('shows the raw output at once when nothing else describes it', () => {
      const node = stateService.addNode('check', 'task', 'Check', 0, 0, {});
      stateService.updateNode(node.id, { state: 'success', lastOutput: { count: 1 } });
      stateService.selectNode(node.id);

      expect(component.hasOutputOverview()).toBe(false);
      expect(component.rawOutputVisible()).toBe(true);
    });
  });
});
