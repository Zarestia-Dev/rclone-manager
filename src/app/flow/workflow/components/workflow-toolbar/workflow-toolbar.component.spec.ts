import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { WorkflowToolbarComponent } from './workflow-toolbar.component';
import { WorkflowStateService } from '../../../../services/flow/workflow-state.service';
import { WorkflowEngineService } from '../../../../services/flow/workflow-engine.service';
import { WorkflowStorageService } from '../../../../services/flow/workflow-storage.service';
import { NotificationService } from '../../../../services/ui/notification.service';
import { provideTranslateService } from '@ngx-translate/core';
import { WorkflowDefinition, WorkflowTemplate } from '../../types/workflow.types';
import { BUILTIN_WORKFLOW_TEMPLATES } from '../../../../services/flow/recipes/workflow-recipes';

describe('WorkflowToolbarComponent', () => {
  let fixture: ComponentFixture<WorkflowToolbarComponent>;
  let stateService: WorkflowStateService;
  let presets: ReturnType<typeof signal<WorkflowTemplate[]>>;

  beforeEach(async () => {
    presets = signal<WorkflowTemplate[]>([]);
    await TestBed.configureTestingModule({
      imports: [WorkflowToolbarComponent],
      providers: [
        provideTranslateService(),
        WorkflowStateService,
        {
          provide: WorkflowEngineService,
          useValue: {
            isExecuting: (): boolean => false,
            executeWorkflow: (): Promise<boolean> => Promise.resolve(true),
            stopWorkflow: vi.fn(),
          },
        },
        {
          provide: WorkflowStorageService,
          useValue: {
            workflows: (): WorkflowDefinition[] => [],
            presetTemplates: presets.asReadonly(),
            saveWorkflow: vi.fn(),
            deleteWorkflow: vi.fn(),
            duplicateWorkflow: vi.fn(),
            cleanDuplicates: vi.fn(),
            instantiateTemplate: vi.fn(),
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
    stateService.createNewWorkflow('Toolbar Test');

    fixture = TestBed.createComponent(WorkflowToolbarComponent);
    fixture.detectChanges();
  });

  it('renders toolbar with workflow name input and controls', () => {
    const el: HTMLElement = fixture.nativeElement;
    const input = el.querySelector('.workflow-name-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe('Toolbar Test');
    expect(el.querySelector('.run-workflow-btn')).toBeTruthy();
    expect(el.querySelector('.dry-run-workflow-btn')).toBeTruthy();
  });

  it('updates an open recipe menu when the shared template state arrives', async () => {
    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'button[title="flow.workflow.toolbar.presets"]'
    );
    expect(button).not.toBeNull();
    button?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const recipe = { ...BUILTIN_WORKFLOW_TEMPLATES[0], name: 'Backup & 旅行', nameKey: undefined };
    presets.set([recipe]);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(document.querySelector('.material-context-menu .option-label')?.textContent).toContain(
      recipe.name
    );
  });

  it('triggers runWorkflow and runWorkflowDryRun on button clicks', () => {
    const engine = TestBed.inject(WorkflowEngineService);
    const runSpy = vi.spyOn(engine, 'executeWorkflow');

    const component = fixture.componentInstance;
    component.runWorkflow();
    expect(runSpy).toHaveBeenCalledWith(expect.anything(), false);

    component.runWorkflowDryRun();
    expect(runSpy).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('renders mobile more actions button', () => {
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.mobile-more-btn')).toBeTruthy();
  });

  it('handles undo, redo, and grid snap helper methods', () => {
    const undoSpy = vi.spyOn(stateService, 'undo');
    const redoSpy = vi.spyOn(stateService, 'redo');

    const component = fixture.componentInstance;
    component.undo();
    expect(undoSpy).toHaveBeenCalled();

    component.redo();
    expect(redoSpy).toHaveBeenCalled();

    const initialSnap = stateService.snapToGrid();
    component.toggleSnapToGrid();
    expect(stateService.snapToGrid()).toBe(!initialSnap);
  });
});
