import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideTranslateService } from '@ngx-translate/core';
import { SidebarComponent } from './sidebar.component';
import { IconService } from 'src/app/services/ui/icon.service';
import { RemoteStatusService } from 'src/app/services/remote/remote-status.service';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';
import { WorkflowStorageService } from 'src/app/services/flow/workflow-storage.service';
import { WorkflowStateService } from 'src/app/services/flow/workflow-state.service';
import { WorkflowEngineService } from 'src/app/services/flow/workflow-engine.service';
import { WorkflowDefinition } from 'src/app/flow/workflow/types/workflow.types';
import { QuickRun } from '@app/types';

describe('SidebarComponent', () => {
  let fixture: ComponentFixture<SidebarComponent>;
  let component: SidebarComponent;

  const mockWorkflows = signal<WorkflowDefinition[]>([
    {
      id: 'wf-1',
      name: 'Backup Workflow',
      description: 'Daily backup job',
      cronExpression: '0 0 * * *',
      nodes: [
        {
          id: 'node-1',
          type: 'cron',
          category: 'trigger',
          title: 'Daily Schedule',
          x: 0,
          y: 0,
          inputs: [],
          outputs: [],
          config: {},
        },
        {
          id: 'node-2',
          type: 'sync',
          category: 'task',
          title: 'Sync Files',
          x: 100,
          y: 100,
          inputs: [],
          outputs: [],
          config: {},
        },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    },
    {
      id: 'wf-2',
      name: 'Watch Workflow',
      nodes: [
        {
          id: 'node-w',
          type: 'watcher',
          category: 'trigger',
          title: 'Folder Watcher',
          x: 0,
          y: 0,
          inputs: [],
          outputs: [],
          config: {},
        },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    },
  ]);

  const mockQuickRuns = signal<QuickRun[]>([
    {
      id: 'qr-1',
      name: 'Quick Sync',
      remoteName: 'my-drive',
      operationType: 'sync',
      status: 'idle',
      config: {
        rclone: { srcFs: 'local:', dstFs: 'drive:' },
        app: {
          autoStart: false,
          cronEnabled: false,
          cronExpression: '',
          watchEnabled: false,
        },
      },
    },
  ]);

  const mockSelectedQuickRunId = signal<string | null>(null);
  const mockCurrentWorkflow = signal<WorkflowDefinition | null>(null);
  const mockIsExecuting = signal<boolean>(false);
  const mockLoadWorkflow = vi.fn();

  beforeEach(async () => {
    mockSelectedQuickRunId.set(null);
    mockCurrentWorkflow.set(null);
    mockIsExecuting.set(false);
    mockLoadWorkflow.mockClear();

    await TestBed.configureTestingModule({
      imports: [SidebarComponent],
      providers: [
        provideTranslateService(),
        {
          provide: IconService,
          useValue: {
            getIconName: (): string => 'folder',
          },
        },
        {
          provide: RemoteStatusService,
          useValue: {
            getMountProfileCount: (): number => 0,
            getSyncProfileCount: (): number => 0,
            getActiveSyncOperationType: (): string => 'sync',
            getActiveSyncOperationIcon: (): string => 'sync',
            getServeProfileCount: (): number => 0,
            getMountTooltip: (): string => '',
            getSyncOperationsTooltip: (): string => '',
            getServeTooltip: (): string => '',
          },
        },
        {
          provide: UiStateService,
          useValue: {
            selectedRemote: signal(null),
            setSelectedRemote: vi.fn(),
          },
        },
        {
          provide: RemoteFacadeService,
          useValue: {
            loading: signal(false),
            hiddenRemoteNames: signal([]),
          },
        },
        {
          provide: QuickRunService,
          useValue: {
            quickRuns: mockQuickRuns,
            selectedId: mockSelectedQuickRunId,
            runningIds: signal(new Set<string>()),
            isLoading: signal(false),
            select: vi.fn(),
          },
        },
        {
          provide: WorkflowStorageService,
          useValue: {
            workflows: mockWorkflows,
            isLoading: signal(false),
          },
        },
        {
          provide: WorkflowStateService,
          useValue: {
            currentWorkflow: mockCurrentWorkflow,
            loadWorkflow: mockLoadWorkflow,
          },
        },
        {
          provide: WorkflowEngineService,
          useValue: {
            isExecuting: mockIsExecuting,
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(SidebarComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('mode', 'flow');
    fixture.detectChanges();
  });

  it('initializes and computes hasAny as true when workflows or quick runs exist', () => {
    expect(component.hasAny()).toBe(true);
    expect(component.filteredWorkflows().length).toBe(2);
    expect(component.filteredQuickRuns().length).toBe(1);
  });

  it('filters workflows based on search term', () => {
    component.onSearchTextChange('backup');
    expect(component.filteredWorkflows().length).toBe(1);
    expect(component.filteredWorkflows()[0].name).toBe('Backup Workflow');

    component.onSearchTextChange('watcher');
    expect(component.filteredWorkflows().length).toBe(1);
    expect(component.filteredWorkflows()[0].name).toBe('Watch Workflow');

    component.onSearchTextChange('nonexistent');
    expect(component.filteredWorkflows().length).toBe(0);
  });

  it('selects workflow and emits events', () => {
    const wf = mockWorkflows()[0];
    const wfSpy = vi.fn();
    const itemSpy = vi.fn();
    component.workflowSelected.subscribe(wfSpy);
    component.itemSelected.subscribe(itemSpy);

    component.selectWorkflow(wf);

    expect(mockLoadWorkflow).toHaveBeenCalledWith(wf);
    expect(wfSpy).toHaveBeenCalledWith(wf);
    expect(itemSpy).toHaveBeenCalled();
  });

  it('detects watcher node properly with hasWatcherNode', () => {
    expect(component.hasWatcherNode(mockWorkflows()[0])).toBe(false);
    expect(component.hasWatcherNode(mockWorkflows()[1])).toBe(true);
  });

  it('returns trigger summary with getWorkflowTriggerSummary', () => {
    expect(component.getWorkflowTriggerSummary(mockWorkflows()[0])).toBe('0 0 * * *');
    expect(component.getWorkflowTriggerSummary(mockWorkflows()[1])).toBe('Folder Watcher');
  });

  it('returns trigger tooltip with getWorkflowTriggerTooltip', () => {
    expect(component.getWorkflowTriggerTooltip(mockWorkflows()[0])).toContain('0 0 * * *');
    expect(component.getWorkflowTriggerTooltip(mockWorkflows()[1])).toBe('Folder Watcher');

    const manualWf: WorkflowDefinition = {
      id: 'wf-m',
      name: 'Manual Flow',
      nodes: [
        {
          id: 'node-m',
          type: 'manual',
          category: 'trigger',
          title: 'Manual Trigger',
          x: 0,
          y: 0,
          inputs: [],
          outputs: [],
          config: {},
        },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    expect(component.getWorkflowTriggerTooltip(manualWf)).toBeTruthy();
  });

  it('detects cron node properly with getWorkflowCron and hasCronNode', () => {
    expect(component.hasCronNode(mockWorkflows()[0])).toBe(true);
    expect(component.getWorkflowCron(mockWorkflows()[0])).toBe('0 0 * * *');

    const wfWithCronNodeOnly: WorkflowDefinition = {
      id: 'wf-cron-only',
      name: 'Cron Only Flow',
      nodes: [
        {
          id: 'node-cron',
          type: 'cron',
          category: 'trigger',
          title: 'Cron Node',
          x: 0,
          y: 0,
          inputs: [],
          outputs: [],
          config: { cronExpression: '0 3 * * *' },
        },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    expect(component.hasCronNode(wfWithCronNodeOnly)).toBe(true);
    expect(component.getWorkflowCron(wfWithCronNodeOnly)).toBe('0 3 * * *');
  });

  it('detects autostart workflow properly with hasAutoStartNode', () => {
    const wfDefault = mockWorkflows()[0];
    expect(component.hasAutoStartNode(wfDefault)).toBe(false);

    const wfAutoStartProp: WorkflowDefinition = {
      ...wfDefault,
      autoStart: true,
    };
    expect(component.hasAutoStartNode(wfAutoStartProp)).toBe(true);

    const wfWithAppStartNode: WorkflowDefinition = {
      id: 'wf-app-start',
      name: 'App Start Flow',
      autoStart: false,
      nodes: [
        {
          id: 'node-start',
          type: 'app_start',
          category: 'trigger',
          title: 'On App Launch',
          x: 0,
          y: 0,
          inputs: [],
          outputs: [],
          config: { delaySeconds: 5 },
        },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    expect(component.hasAutoStartNode(wfWithAppStartNode)).toBe(true);
  });

  it('returns correct workflow trigger icon via getWorkflowTriggerIcon', () => {
    expect(component.getWorkflowTriggerIcon(mockWorkflows()[0])).toBe('clock');
    expect(component.getWorkflowTriggerIcon(mockWorkflows()[1])).toBe('sync');

    const wfManual: WorkflowDefinition = {
      id: 'wf-manual',
      name: 'Manual Flow',
      nodes: [
        {
          id: 'node-m',
          type: 'manual',
          category: 'trigger',
          title: 'Manual Trigger',
          x: 0,
          y: 0,
          inputs: [],
          outputs: [],
          config: {},
        },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    expect(component.getWorkflowTriggerIcon(wfManual)).toBe('play');
  });

  it('renders flow section headers and marks active section based on flowSubMode', () => {
    fixture.componentRef.setInput('flowSubMode', 'quick_run');
    fixture.detectChanges();

    const headers = fixture.nativeElement.querySelectorAll('.flow-section-header');
    expect(headers.length).toBe(2);
    expect(headers[0].classList.contains('active-section')).toBe(true);
    expect(headers[1].classList.contains('active-section')).toBe(false);

    fixture.componentRef.setInput('flowSubMode', 'builder');
    fixture.detectChanges();

    expect(headers[0].classList.contains('active-section')).toBe(false);
    expect(headers[1].classList.contains('active-section')).toBe(true);
  });

  it('distinguishes panel selection mutually exclusively based on flowSubMode', () => {
    // Both services have an active/loaded entity
    mockSelectedQuickRunId.set('qr-1');
    mockCurrentWorkflow.set(mockWorkflows()[0]); // id: 'wf-1'

    // When flowSubMode is 'quick_run', ONLY quick run is selected
    fixture.componentRef.setInput('flowSubMode', 'quick_run');
    fixture.detectChanges();

    expect(component.isQuickRunSelected('qr-1')).toBe(true);
    expect(component.isWorkflowSelected('wf-1')).toBe(false);

    const cards = fixture.nativeElement.querySelectorAll('.sidebar-card');
    // First card is quick run 'qr-1'
    expect(cards[0].classList.contains('selected')).toBe(true);
    // Second card is workflow 'wf-1'
    expect(cards[1].classList.contains('selected')).toBe(false);

    // When switching to 'builder' (workflow), ONLY workflow is selected
    fixture.componentRef.setInput('flowSubMode', 'builder');
    fixture.detectChanges();

    expect(component.isQuickRunSelected('qr-1')).toBe(false);
    expect(component.isWorkflowSelected('wf-1')).toBe(true);

    expect(cards[0].classList.contains('selected')).toBe(false);
    expect(cards[1].classList.contains('selected')).toBe(true);
  });
});
