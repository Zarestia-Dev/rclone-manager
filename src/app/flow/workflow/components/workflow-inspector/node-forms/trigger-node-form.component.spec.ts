import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { TriggerNodeFormComponent } from './trigger-node-form.component';
import { WorkflowNode } from '../../../types/workflow.types';

describe('TriggerNodeFormComponent', () => {
  let fixture: ComponentFixture<TriggerNodeFormComponent>;
  let component: TriggerNodeFormComponent;

  const mockNode: WorkflowNode = {
    id: 'node-cron-1',
    type: 'cron',
    category: 'trigger',
    title: 'Cron Node',
    x: 0,
    y: 0,
    inputs: [],
    outputs: [],
    config: { cronExpression: '0 2 * * *' },
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TriggerNodeFormComponent],
      providers: [provideTranslateService()],
    }).compileComponents();

    fixture = TestBed.createComponent(TriggerNodeFormComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('node', mockNode);
    fixture.componentRef.setInput('nodeConfig', { cronExpression: '0 2 * * *' });
    fixture.detectChanges();
  });

  it('computes human readable cron expression and valid state', () => {
    expect(component.cronHumanReadable()).toContain('2:00 AM');
    expect(component.isCronInvalid()).toBe(false);
  });

  it('renders operation-summary-card for cron and emits openDetailed', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.operation-summary-card')).toBeTruthy();
    expect(compiled.textContent).toContain('0 2 * * *');

    let detailedOpened = false;
    component.openDetailed.subscribe(() => {
      detailedOpened = true;
    });

    const editBtn = compiled.querySelector('.btn-edit-config') as HTMLButtonElement | null;
    expect(editBtn).toBeTruthy();
    editBtn?.click();
    expect(detailedOpened).toBe(true);
  });

  it('handles invalid cron expression gracefully', () => {
    fixture.componentRef.setInput('nodeConfig', { cronExpression: 'invalid-cron' });
    fixture.detectChanges();
    expect(component.isCronInvalid()).toBe(true);
    expect(component.cronHumanReadable()).toBe('flow.workflow.inspector.invalidCron');
  });

  it('emits configChange when cron preset is applied', () => {
    let emitted: { key: string; value: unknown } | null = null;
    component.configChange.subscribe(val => {
      emitted = val;
    });

    component.applyCronPreset('0 * * * *');
    expect(emitted).toEqual({ key: 'cronExpression', value: '0 * * * *' });
  });

  it('emits configChange when app_start preset is applied', () => {
    let emitted: { key: string; value: unknown } | null = null;
    component.configChange.subscribe(val => {
      emitted = val;
    });

    component.applyAppStartPreset(30);
    expect(emitted).toEqual({ key: 'delaySeconds', value: 30 });
  });

  it('computes watchPath correctly from watchPaths array', () => {
    fixture.componentRef.setInput('nodeConfig', { watchPaths: ['/test/folder'] });
    fixture.detectChanges();
    expect(component.watchPath()).toBe('/test/folder');
  });

  it('emits configChange when debounce preset is applied', () => {
    let emitted: { key: string; value: unknown } | null = null;
    component.configChange.subscribe(val => {
      emitted = val;
    });

    component.applyDebouncePreset(10);
    expect(emitted).toEqual({ key: 'debounceSeconds', value: 10 });
  });

  it('emits configChange when job_event fields are updated', () => {
    const jobEventNode: WorkflowNode = {
      id: 'node-job-1',
      type: 'job_event',
      category: 'trigger',
      title: 'Job Finish Event',
      x: 0,
      y: 0,
      inputs: [],
      outputs: [],
      config: { targetProfileId: '', eventState: 'any' },
    };
    fixture.componentRef.setInput('node', jobEventNode);
    fixture.componentRef.setInput('nodeConfig', { targetProfileId: '', eventState: 'any' });
    fixture.componentRef.setInput('allProfiles', ['Backup Profile', 'Quick Sync']);
    fixture.detectChanges();

    let emitted: { key: string; value: unknown } | null = null;
    component.configChange.subscribe(val => {
      emitted = val;
    });

    component.onFieldChange('targetProfileId', 'Backup Profile');
    expect(emitted).toEqual({ key: 'targetProfileId', value: 'Backup Profile' });

    component.onFieldChange('eventState', 'success');
    expect(emitted).toEqual({ key: 'eventState', value: 'success' });
  });
});
