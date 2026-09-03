import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WorkflowToolbarComponent } from './workflow-toolbar.component';
import { WorkflowStateService } from '../../../../services/flow/workflow-state.service';
import { WorkflowEngineService } from '../../../../services/flow/workflow-engine.service';
import { WorkflowStorageService } from '../../../../services/flow/workflow-storage.service';
import { NotificationService } from '../../../../services/ui/notification.service';
import { provideTranslateService } from '@ngx-translate/core';
import { WorkflowDefinition } from '../../types/workflow.types';

describe('WorkflowToolbarComponent', () => {
  let fixture: ComponentFixture<WorkflowToolbarComponent>;
  let stateService: WorkflowStateService;

  beforeEach(async () => {
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
            getPresetTemplates: (): WorkflowDefinition[] => [],
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

  it('triggers runWorkflow and runWorkflowDryRun on button clicks', () => {
    const engine = TestBed.inject(WorkflowEngineService);
    const runSpy = vi.spyOn(engine, 'executeWorkflow');

    const component = fixture.componentInstance;
    component.runWorkflow();
    expect(runSpy).toHaveBeenCalledWith(expect.anything(), false);

    component.runWorkflowDryRun();
    expect(runSpy).toHaveBeenCalledWith(expect.anything(), true);
  });
});
