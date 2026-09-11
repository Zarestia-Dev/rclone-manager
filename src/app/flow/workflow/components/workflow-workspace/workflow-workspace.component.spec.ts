import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WorkflowWorkspaceComponent } from './workflow-workspace.component';
import { WorkflowStateService } from '../../../../services/flow/workflow-state.service';
import { WorkflowEngineService } from '../../../../services/flow/workflow-engine.service';
import { WorkflowStorageService } from '../../../../services/flow/workflow-storage.service';
import { RemoteFacadeService } from '../../../../services/facade/remote-facade.service';
import { NotificationService } from '../../../../services/ui/notification.service';
import { provideTranslateService } from '@ngx-translate/core';
import { WorkflowDefinition } from '../../types/workflow.types';

describe('WorkflowWorkspaceComponent', () => {
  let fixture: ComponentFixture<WorkflowWorkspaceComponent>;
  let component: WorkflowWorkspaceComponent;
  let stateService: WorkflowStateService;
  let storageService: WorkflowStorageService;
  let notificationService: NotificationService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [WorkflowWorkspaceComponent],
      providers: [
        provideTranslateService(),
        WorkflowStateService,
        {
          provide: WorkflowEngineService,
          useValue: {
            isExecuting: (): boolean => false,
            logs: (): unknown[] => [],
            activeEdgeIds: (): Set<string> => new Set(),
            executeWorkflow: (): Promise<boolean> => Promise.resolve(true),
            stopWorkflow: vi.fn(),
            clearLogs: vi.fn(),
          },
        },
        {
          provide: WorkflowStorageService,
          useValue: {
            workflows: (): WorkflowDefinition[] => [],
            getPresetTemplates: (): WorkflowDefinition[] => [],
            saveWorkflow: vi.fn().mockResolvedValue({}),
            deleteWorkflow: vi.fn(),
            duplicateWorkflow: vi.fn(),
            cleanDuplicates: vi.fn(),
            instantiateTemplate: (): WorkflowDefinition => ({
              id: 'wf-1',
              name: 'Init Flow',
              nodes: [],
              edges: [],
              viewport: { x: 0, y: 0, zoom: 1 },
            }),
          },
        },
        {
          provide: RemoteFacadeService,
          useValue: {
            orderedVisibleRemotes: (): unknown[] => [],
          },
        },
        {
          provide: NotificationService,
          useValue: {
            showSuccess: vi.fn(),
            showError: vi.fn(),
            confirmModal: vi.fn().mockResolvedValue(true),
          },
        },
      ],
    }).compileComponents();

    stateService = TestBed.inject(WorkflowStateService);
    storageService = TestBed.inject(WorkflowStorageService);
    notificationService = TestBed.inject(NotificationService);
    fixture = TestBed.createComponent(WorkflowWorkspaceComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders empty state when no workflow is loaded', () => {
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.workflow-empty-state')).toBeTruthy();
    expect(el.querySelector('app-workflow-toolbar')).toBeNull();
    expect(el.querySelector('app-workflow-canvas')).toBeNull();
  });

  it('renders workspace layout with toolbar and canvas when workflow is loaded', () => {
    stateService.createNewWorkflow('Test Flow');
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.workflow-empty-state')).toBeNull();
    expect(el.querySelector('app-workflow-toolbar')).toBeTruthy();
    expect(el.querySelector('app-workflow-canvas')).toBeTruthy();
  });

  it('renders palette sidenav at start and inspector sidenav at end when workflow is loaded', () => {
    stateService.createNewWorkflow('Test Flow');
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    const paletteSidenav = el.querySelector('mat-sidenav.palette-sidenav');
    const inspectorSidenav = el.querySelector('mat-sidenav.inspector-sidenav');

    expect(paletteSidenav).toBeTruthy();
    expect(paletteSidenav?.getAttribute('position')).toBe('start');
    expect(inspectorSidenav).toBeTruthy();
    expect(inspectorSidenav?.getAttribute('position')).toBe('end');
    expect(inspectorSidenav?.querySelector('app-workflow-inspector')).toBeTruthy();
  });

  it('toggles palette visibility', () => {
    expect(component.isPaletteOpen()).toBe(true);
    component.togglePalette();
    expect(component.isPaletteOpen()).toBe(false);
  });

  it('renders floating palette-open-trigger when palette is closed and clicking it opens palette', () => {
    stateService.createNewWorkflow('Test Flow');
    component.isPaletteOpen.set(false);
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    const trigger = el.querySelector('.palette-open-trigger') as HTMLButtonElement;
    expect(trigger).toBeTruthy();

    trigger.click();
    fixture.detectChanges();
    expect(component.isPaletteOpen()).toBe(true);
    expect(el.querySelector('.palette-open-trigger')).toBeNull();
  });

  it('toggles inspector visibility', () => {
    expect(component.isInspectorOpen()).toBe(true);
    component.toggleInspector();
    expect(component.isInspectorOpen()).toBe(false);
    component.toggleInspector();
    expect(component.isInspectorOpen()).toBe(true);
  });

  it('renders floating inspector-open-trigger when inspector is closed and clicking it opens inspector', () => {
    stateService.createNewWorkflow('Test Flow');
    component.isInspectorOpen.set(false);
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    const trigger = el.querySelector('.inspector-open-trigger') as HTMLButtonElement;
    expect(trigger).toBeTruthy();

    trigger.click();
    fixture.detectChanges();
    expect(component.isInspectorOpen()).toBe(true);
    expect(el.querySelector('.inspector-open-trigger')).toBeNull();
  });

  it('does not render unsaved changes banner when workflow has no changes', () => {
    stateService.createNewWorkflow('Clean Flow');
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.workflow-unsaved-banner')).toBeNull();
  });

  it('renders floating unsaved changes banner when workflow is modified and saves on click', async () => {
    stateService.createNewWorkflow('Dirty Flow');
    fixture.detectChanges();

    // Modify workflow to make it dirty
    stateService.addNode('sync', 'task', 'New Task', 100, 100);
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    const banner = el.querySelector('.workflow-unsaved-banner') as HTMLElement;
    expect(banner).toBeTruthy();
    expect(banner.querySelector('.unsaved-indicator-dot')).toBeTruthy();
    expect(banner.querySelector('.unsaved-label')).toBeTruthy();

    const saveBtn = banner.querySelector('.unsaved-save-btn') as HTMLButtonElement;
    expect(saveBtn).toBeTruthy();

    // Click save button
    saveBtn.click();
    await new Promise(resolve => setTimeout(resolve, 50));
    fixture.detectChanges();

    expect(storageService.saveWorkflow).toHaveBeenCalled();
    expect(stateService.hasUnsavedChanges()).toBe(false);
  });

  it('handles Ctrl+S keyboard shortcut to save dirty workflow', () => {
    stateService.createNewWorkflow('Keyboard Flow');
    stateService.addNode('sync', 'task', 'New Task', 100, 100);
    fixture.detectChanges();

    const saveSpy = vi.spyOn(component, 'saveWorkflow');
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true });
    window.dispatchEvent(event);

    expect(saveSpy).toHaveBeenCalled();
  });

  it('shows error notification when saveWorkflow rejects', async () => {
    stateService.createNewWorkflow('Error Flow');
    stateService.addNode('sync', 'task', 'New Task', 100, 100);
    fixture.detectChanges();

    vi.spyOn(storageService, 'saveWorkflow').mockRejectedValueOnce(new Error('Save failed'));
    await component.saveWorkflow();

    expect(notificationService.showError).toHaveBeenCalled();
  });

  it('creates new workflow from empty state', () => {
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.workflow-empty-state')).toBeTruthy();

    component.createNewWorkflow();
    fixture.detectChanges();

    expect(stateService.currentWorkflow()).toBeTruthy();
    expect(el.querySelector('.workflow-empty-state')).toBeNull();
    expect(el.querySelector('app-workflow-toolbar')).toBeTruthy();
  });

  it('loads workflow by ID from empty state', () => {
    const wf: WorkflowDefinition = {
      id: 'wf-test',
      name: 'Existing Flow',
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };

    vi.spyOn(storageService, 'workflows').mockReturnValue([wf]);
    fixture.detectChanges();

    component.loadWorkflowById('wf-test');
    fixture.detectChanges();

    expect(stateService.currentWorkflow()?.id).toBe('wf-test');
  });

  describe('getTemplatePillClass', () => {
    it('returns p-primary for backup category', () => {
      expect(component.getTemplatePillClass('backup')).toBe('p-primary');
    });

    it('returns p-orange for automation category', () => {
      expect(component.getTemplatePillClass('automation')).toBe('p-orange');
    });

    it('returns p-accent for sync category', () => {
      expect(component.getTemplatePillClass('sync')).toBe('p-accent');
    });

    it('returns p-purple for utility category', () => {
      expect(component.getTemplatePillClass('utility')).toBe('p-purple');
    });

    it('returns p-accent for unknown categories as fallback', () => {
      expect(component.getTemplatePillClass('custom')).toBe('p-accent');
    });
  });

  describe('Responsive & Mobile Sidenav Behavior', () => {
    it('initializes sidebarMode to side by default', () => {
      expect(component.sidebarMode()).toBe('side');
      expect(component.isSidebarOver()).toBe(false);
    });

    it('coordinates palette and inspector in over mode so only one opens at a time', () => {
      component.sidebarMode.set('over');
      expect(component.isSidebarOver()).toBe(true);

      // Open palette
      component.openPalette();
      expect(component.isPaletteOpen()).toBe(true);
      expect(component.isInspectorOpen()).toBe(false);

      // Open inspector -> closes palette
      component.openInspector();
      expect(component.isInspectorOpen()).toBe(true);
      expect(component.isPaletteOpen()).toBe(false);

      // Toggle palette back open -> closes inspector
      component.togglePalette();
      expect(component.isPaletteOpen()).toBe(true);
      expect(component.isInspectorOpen()).toBe(false);
    });

    it('closes palette on nodeAdded when in over mode', () => {
      component.sidebarMode.set('over');
      component.isPaletteOpen.set(true);

      component.onNodeAdded();
      expect(component.isPaletteOpen()).toBe(false);
    });

    it('does not close palette on nodeAdded when in side mode', () => {
      component.sidebarMode.set('side');
      component.isPaletteOpen.set(true);

      component.onNodeAdded();
      expect(component.isPaletteOpen()).toBe(true);
    });

    it('auto-opens inspector in over mode when a node is selected', () => {
      stateService.createNewWorkflow('Mobile Select Test');
      const node = stateService.addNode('sync', 'task', 'Node 1', 10, 10);
      component.sidebarMode.set('over');
      component.isPaletteOpen.set(true);
      component.isInspectorOpen.set(false);

      stateService.selectNode(node.id);
      TestBed.tick();

      expect(component.isInspectorOpen()).toBe(true);
      expect(component.isPaletteOpen()).toBe(false);
    });
  });
});
