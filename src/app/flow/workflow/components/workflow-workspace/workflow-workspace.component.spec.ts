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

  it('renders workspace layout with toolbar and canvas', () => {
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('app-workflow-toolbar')).toBeTruthy();
    expect(el.querySelector('app-workflow-canvas')).toBeTruthy();
  });

  it('renders palette sidenav at start and inspector sidenav at end', () => {
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
});
