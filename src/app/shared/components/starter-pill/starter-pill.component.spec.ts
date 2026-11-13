import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { MatIcon } from '@angular/material/icon';
import { beforeEach, describe, expect, it } from 'vitest';
import { Starter } from '@app/types';
import { StarterPillComponent } from './starter-pill.component';

describe('StarterPillComponent', () => {
  let fixture: ComponentFixture<StarterPillComponent>;

  const render = (starter?: Starter): HTMLElement => {
    fixture.componentRef.setInput('starter', starter);
    fixture.detectChanges();
    return fixture.nativeElement;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [StarterPillComponent] });
    fixture = TestBed.createComponent(StarterPillComponent);
  });

  it('names the profile of a profile job, without an icon', () => {
    const element = render({ kind: 'profile', name: 'Test 1' });
    expect(element.querySelector('[appPill]')?.textContent?.trim()).toBe('Test 1');
    expect(element.querySelector('mat-icon')).toBeNull();
  });

  it('names the Quick Run of a Quick Run job, marked with the Quick Run icon', () => {
    const element = render({ kind: 'quick_run', id: 'qr-1', name: 'Nightly' });
    expect(element.querySelector('[appPill]')?.textContent?.trim()).toBe('Nightly');
    expect(fixture.debugElement.query(By.directive(MatIcon)).componentInstance.svgIcon).toBe(
      'quick-run'
    );
  });

  it('names the Quick Run even when a workflow node ran it', () => {
    const element = render({
      kind: 'quick_run',
      id: 'qr-1',
      name: 'Nightly',
      workflow: { workflowId: 'wf', workflowName: 'Workflow', nodeId: 'n1', ancestors: [] },
    });
    expect(element.querySelector('[appPill]')?.textContent?.trim()).toBe('Nightly');
  });

  it('names the workflow of a workflow node, marked with the workflow icon', () => {
    const element = render({
      kind: 'workflow',
      workflowId: 'wf',
      workflowName: 'Nightly backup',
      nodeId: 'n1',
      ancestors: [],
    });
    expect(element.querySelector('[appPill]')?.textContent?.trim()).toBe('Nightly backup');
    expect(fixture.debugElement.query(By.directive(MatIcon)).componentInstance.svgIcon).toBe(
      'workflow'
    );
  });

  it('shows nothing for work nothing started', () => {
    expect(render(undefined).querySelector('[appPill]')).toBeNull();
  });
});
