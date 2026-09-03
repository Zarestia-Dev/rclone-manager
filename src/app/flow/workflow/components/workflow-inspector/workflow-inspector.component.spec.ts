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
import { AlertService } from '../../../../services/alerts/alert.service';
import { MountedRemote } from '../../../../shared/types/remotes';
import { ServeListItem } from '../../../../shared/types/serve';

describe('WorkflowInspectorComponent', () => {
  let fixture: ComponentFixture<WorkflowInspectorComponent>;
  let component: WorkflowInspectorComponent;
  let stateService: WorkflowStateService;
  let modalServiceSpy: { openWorkflowNodeEditor: ReturnType<typeof vi.fn> };
  let storageServiceSpy: {
    saveWorkflow: ReturnType<typeof vi.fn>;
    duplicateWorkflow: ReturnType<typeof vi.fn>;
    exportWorkflowJson: ReturnType<typeof vi.fn>;
    deleteWorkflow: ReturnType<typeof vi.fn>;
    workflows: ReturnType<typeof vi.fn>;
  };
  let notificationServiceSpy: {
    showSuccess: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    confirmModal: ReturnType<typeof vi.fn>;
  };
  let mountedRemotesSignal: ReturnType<typeof signal<MountedRemote[]>>;
  let runningServesSignal: ReturnType<typeof signal<ServeListItem[]>>;

  beforeEach(async () => {
    modalServiceSpy = { openWorkflowNodeEditor: vi.fn() };
    storageServiceSpy = {
      saveWorkflow: vi.fn().mockResolvedValue({}),
      duplicateWorkflow: vi
        .fn()
        .mockResolvedValue({ id: 'wf-2', name: 'Inspector Test (Copy)', nodes: [], edges: [] }),
      exportWorkflowJson: vi.fn().mockResolvedValue('{"id":"wf-1"}'),
      deleteWorkflow: vi.fn().mockResolvedValue(undefined),
      workflows: vi.fn().mockReturnValue([]),
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
          useValue: { orderedVisibleRemotes: (): unknown[] => [{ name: 'drive', type: 'drive' }] },
        },
        {
          provide: ModalService,
          useValue: modalServiceSpy,
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
        workflow_id: 'other-wf',
        node_id: 'other-node',
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
        workflow_id: wfId,
        node_id: mountNode.id,
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

  it('updates workflow name and description from inspector', () => {
    stateService.clearSelection();
    fixture.detectChanges();

    component.onWorkflowNameChange('Renamed Flow');
    expect(stateService.currentWorkflow()?.name).toBe('Renamed Flow');

    component.onWorkflowDescriptionChange('New Flow Description');
    expect(stateService.currentWorkflow()?.description).toBe('New Flow Description');
  });

  it('updates notification node icon when actionKind or icon changes', () => {
    const notifNode = stateService.addNode('notification', 'action', 'Notify', 0, 0, {
      config: { title: 'Test' },
    });
    stateService.selectNode(notifNode.id);
    fixture.detectChanges();

    component.onConfigFieldChange('actionKind', 'whatsapp');
    expect(component.nodeIcon()).toBe('whatsapp');
    expect(stateService.selectedNode()?.icon).toBe('whatsapp');

    component.onConfigFieldChange('actionKind', 'telegram');
    expect(component.nodeIcon()).toBe('telegram');
    expect(stateService.selectedNode()?.icon).toBe('telegram');
  });
});
