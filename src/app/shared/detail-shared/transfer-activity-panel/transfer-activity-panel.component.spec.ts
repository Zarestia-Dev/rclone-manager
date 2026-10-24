import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { CompletedTransfer, ResolveState, TransferActivityPanelConfig } from '@app/types';
import { TransferActivityPanelComponent } from './transfer-activity-panel.component';

const row = (status: CompletedTransfer['status']): CompletedTransfer => ({
  jobid: 7,
  name: 'same-file.txt',
  status,
  checked: status === 'checked',
  error: '',
  size: 100,
  bytes: status === 'completed' ? 100 : 0,
});

const config = (completedTransfers: CompletedTransfer[]): TransferActivityPanelConfig => ({
  activeTransfers: [],
  completedTransfers,
  remoteName: 'drive',
  showHistory: true,
  jobType: 'sync',
});

describe('transfer activity status filters', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({});
    TestBed.overrideComponent(TransferActivityPanelComponent, {
      set: { template: '', imports: [] },
    });
  });

  it('offers no filter choice for empty or uniform results', () => {
    const fixture = TestBed.createComponent(TransferActivityPanelComponent);
    fixture.componentRef.setInput('config', config([]));
    expect(fixture.componentInstance.statusOptions()).toHaveLength(0);
    fixture.componentRef.setInput('config', config([row('failed'), row('failed')]));
    expect(fixture.componentInstance.statusOptions()).toHaveLength(1);
    expect(fixture.componentInstance.statusOptions()[0].count).toBe(2);
  });

  it('keeps checked, completed and failed entries distinct, including the same file', () => {
    const fixture = TestBed.createComponent(TransferActivityPanelComponent);
    fixture.componentRef.setInput(
      'config',
      config([row('checked'), row('completed'), row('failed'), row('checked')])
    );
    expect(
      fixture.componentInstance.statusOptions().map(({ status, count }) => ({ status, count }))
    ).toEqual([
      { status: 'completed', count: 1 },
      { status: 'checked', count: 2 },
      { status: 'failed', count: 1 },
    ]);
  });

  it('preserves a selected status during polling and clears it when there is no longer a choice', () => {
    const fixture = TestBed.createComponent(TransferActivityPanelComponent);
    const component = fixture.componentInstance;
    fixture.componentRef.setInput('config', config([row('checked'), row('failed')]));
    component.statusFilter.set('failed');
    fixture.componentRef.setInput('config', config([row('checked'), row('failed'), row('failed')]));
    expect(component.statusFilter()).toBe('failed');
    fixture.componentRef.setInput('config', config([row('checked')]));
    expect(component.statusFilter()).toBeNull();
  });

  it('clears a previous selection when switching jobs or remotes', () => {
    const fixture = TestBed.createComponent(TransferActivityPanelComponent);
    const component = fixture.componentInstance;
    fixture.componentRef.setInput('config', config([row('checked'), row('failed')]));
    component.statusFilter.set('failed');
    fixture.componentRef.setInput(
      'config',
      config([
        { ...row('checked'), jobid: 8 },
        { ...row('failed'), jobid: 8 },
      ])
    );
    expect(component.statusFilter()).toBeNull();
    component.statusFilter.set('failed');
    fixture.componentRef.setInput('config', {
      ...config([row('checked'), row('failed')]),
      remoteName: 'other',
    });
    expect(component.statusFilter()).toBeNull();
  });

  it('counts repaired rows by their displayed result without rewriting the original status', () => {
    const fixture = TestBed.createComponent(TransferActivityPanelComponent);
    const resolveState: ResolveState = {
      status: 'Completed',
      percentage: 100,
      isPreparing: false,
      bytes: 100,
      size: 100,
      speed: 0,
      eta: 0,
    };
    const repaired = { ...row('failed'), resolveState };
    fixture.componentRef.setInput('config', config([repaired, row('checked')]));
    expect(fixture.componentInstance.statusOptions().map(option => option.status)).toEqual([
      'completed',
      'checked',
    ]);
    expect(repaired.status).toBe('failed');
  });
});
