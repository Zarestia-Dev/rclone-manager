import { describe, it, expect, beforeEach } from 'vitest';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { WorkflowRunSummaryComponent } from './workflow-run-summary.component';
import {
  WorkflowEngineService,
  WorkflowRunView,
} from '../../../../services/flow/workflow-engine.service';
import { WorkflowStateService } from '../../../../services/flow/workflow-state.service';

describe('WorkflowRunSummaryComponent', () => {
  let fixture: ComponentFixture<WorkflowRunSummaryComponent>;
  let stateService: WorkflowStateService;
  let run: ReturnType<typeof signal<WorkflowRunView | undefined>>;

  const view = (over: Partial<WorkflowRunView> = {}): WorkflowRunView => ({
    runId: 'run-1',
    dryRun: false,
    state: 'completed',
    startedAt: '2026-01-01T00:00:00.000Z',
    seq: 3,
    progress: { total: 2, completed: 2, currentStepTitle: '' },
    steps: ['b', 'a'],
    ...over,
  });

  const text = (): string => fixture.nativeElement.textContent;
  const rows = (): HTMLElement[] => Array.from(fixture.nativeElement.querySelectorAll('.run-step'));

  beforeEach(() => {
    run = signal<WorkflowRunView | undefined>(undefined);
    TestBed.configureTestingModule({
      imports: [WorkflowRunSummaryComponent],
      providers: [
        provideTranslateService(),
        WorkflowStateService,
        {
          provide: WorkflowEngineService,
          useValue: { runView: (): WorkflowRunView | undefined => run() },
        },
      ],
    });
    stateService = TestBed.inject(WorkflowStateService);
    const wf = stateService.createNewWorkflow('Run');
    const a = stateService.addNode('manual', 'trigger', 'Start', 0, 0);
    const b = stateService.addNode('sync', 'task', 'Copy files', 0, 0);
    stateService.recordNodeRun(wf.id, a.id, 'success', undefined, 12);
    stateService.recordNodeRun(wf.id, b.id, 'failed', 'disk full', 340);
    run.set(view({ steps: [b.id, a.id] }));
    fixture = TestBed.createComponent(WorkflowRunSummaryComponent);
    fixture.detectChanges();
  });

  it('says so until the workflow has run', () => {
    run.set(undefined);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.run-steps')).toBeNull();
    expect(fixture.nativeElement.querySelector('.empty-state')).toBeTruthy();
  });

  it('asks to be closed', () => {
    let closed = 0;
    fixture.componentInstance.closePanel.subscribe(() => closed++);
    const buttons = fixture.nativeElement.querySelectorAll('.run-actions button');
    buttons[buttons.length - 1].click();
    expect(closed).toBe(1);
  });

  it('counts the steps by state and leaves out the states nobody is in', () => {
    expect(fixture.componentInstance.counts()).toEqual([
      { state: 'failed', count: 1 },
      { state: 'success', count: 1 },
    ]);
  });

  it('puts failed steps first however many steps there are', () => {
    const wf = stateService.currentWorkflow();
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) {
      const node = stateService.addNode('sync', 'task', `Step ${i}`, 0, 0);
      stateService.recordNodeRun(
        wf?.id ?? '',
        node.id,
        i === 39 ? 'failed' : 'success',
        undefined,
        1
      );
      ids.push(node.id);
    }
    run.update(r => (r ? { ...r, steps: [...ids] } : r));
    fixture.detectChanges();

    const shown = rows();
    expect(shown).toHaveLength(40);
    expect(shown[0].textContent).toContain('Step 39');
    expect(shown[1].textContent).toContain('Step 0');
  });

  it('lists one row per step in the order they reported, with duration and error', () => {
    const shown = rows();
    expect(shown).toHaveLength(2);
    expect(shown[0].textContent).toContain('Copy files');
    expect(shown[0].textContent).toContain('340ms');
    expect(shown[0].textContent).toContain('disk full');
    expect(shown[1].textContent).toContain('Start');
    expect(shown[1].textContent).not.toContain('disk full');
  });

  it('shows the counter and the dry-run tag', () => {
    expect(text()).toContain('2/2');
    expect(text()).not.toContain('flow.workflow.toolbar.dryRun');

    run.update(r => (r ? { ...r, dryRun: true } : r));
    fixture.detectChanges();
    expect(text()).toContain('flow.workflow.toolbar.dryRun');
  });

  it('shows why a run failed, but not a message of a run that did not', () => {
    run.update(r => (r ? { ...r, state: 'failed', message: 'Check failed' } : r));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-alert-banner')?.textContent).toContain(
      'Check failed'
    );

    run.update(r => (r ? { ...r, state: 'completed' } : r));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-alert-banner')).toBeNull();
  });

  it('translates the backend message when it shows it, not when it arrived', () => {
    const raw =
      '{"key":"backendErrors.workflow.finishedWithFailures","params":{"count":"1","name":"Sync"}}';
    // the message arrived before the translations were loaded
    run.update(r => (r ? { ...r, state: 'failed', message: raw } : r));
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', {
      backendErrors: {
        workflow: {
          finishedWithFailures: "Workflow '{{name}}' finished with {{count}} failed step(s)",
        },
      },
    });
    translate.use('en');
    fixture = TestBed.createComponent(WorkflowRunSummaryComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-alert-banner')?.textContent).toContain(
      "Workflow 'Sync' finished with 1 failed step(s)"
    );
  });

  it('translates the error of a step, in the row and in the copied text', () => {
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', {
      backendErrors: { workflow: { jobStopped: 'Job {{id}} was stopped' } },
    });
    translate.use('en');
    const wf = stateService.currentWorkflow();
    const node = wf?.nodes[1];
    stateService.recordNodeRun(
      wf?.id ?? '',
      node?.id ?? '',
      'failed',
      '{"key":"backendErrors.workflow.jobStopped","params":{"id":"7"}}',
      5
    );
    fixture.detectChanges();

    expect(rows()[0].querySelector('.step-error')?.textContent).toContain('Job 7 was stopped');
    expect(fixture.componentInstance.summaryText()).toContain('Job 7 was stopped');
  });

  it('skips a step the workflow no longer has', () => {
    run.update(r => (r ? { ...r, steps: ['removed', ...r.steps] } : r));
    fixture.detectChanges();
    expect(rows()).toHaveLength(2);
  });

  it('opens the step in the inspector when its row is clicked', () => {
    rows()[1].click();
    expect(stateService.selectedNode()?.title).toBe('Start');
  });

  it('copies the run as plain text', () => {
    const copied = fixture.componentInstance.summaryText().split('\n');
    expect(copied[0]).toContain('2026-01-01T00:00:00.000Z');
    expect(copied[1]).toContain('Copy files');
    expect(copied[1]).toContain('(340ms)');
    expect(copied[1]).toContain('disk full');
    expect(copied[2]).toContain('Start');
  });
});
