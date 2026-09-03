import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WorkflowExecutionLogComponent } from './workflow-execution-log.component';
import { WorkflowEngineService } from '../../../../services/flow/workflow-engine.service';
import { provideTranslateService } from '@ngx-translate/core';
import { WorkflowLogEntry } from '../../types/workflow.types';

describe('WorkflowExecutionLogComponent', () => {
  let fixture: ComponentFixture<WorkflowExecutionLogComponent>;
  let component: WorkflowExecutionLogComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [WorkflowExecutionLogComponent],
      providers: [
        provideTranslateService(),
        {
          provide: WorkflowEngineService,
          useValue: {
            logs: (): WorkflowLogEntry[] => [
              {
                id: '1',
                workflowId: 'w1',
                timestamp: new Date(),
                severity: 'info',
                message: 'Step 1 ran',
              },
            ],
            isExecuting: (): boolean => false,
            executionProgress: (): null => null,
            clearLogs: vi.fn(),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(WorkflowExecutionLogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders log entries and badge count', () => {
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.log-count-badge')?.textContent).toBe('1');
    expect(el.querySelector('.log-message')?.textContent).toContain('Step 1 ran');
  });

  it('toggles collapse state', () => {
    expect(component.isCollapsed()).toBe(false);
    component.toggleCollapse();
    expect(component.isCollapsed()).toBe(true);
  });
});
