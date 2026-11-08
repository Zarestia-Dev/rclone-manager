import { TestBed } from '@angular/core/testing';
import { Clipboard } from '@angular/cdk/clipboard';
import { provideTranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationService } from 'src/app/services/ui/notification.service';
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
  const copy = vi.fn();
  const showSuccess = vi.fn();
  const showError = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    copy.mockReturnValue(true);
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        { provide: Clipboard, useValue: { copy } },
        { provide: NotificationService, useValue: { showSuccess, showError } },
      ],
    });
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

  it('offers the reports of a finished job, and never of one that is still running', () => {
    const fixture = TestBed.createComponent(TransferActivityPanelComponent);
    const component = fixture.componentInstance;
    fixture.componentRef.setInput('config', config([row('checked')]));
    expect(component.showReport()).toBe(false);
    fixture.componentRef.setInput('config', {
      ...config([]),
      showHistory: false,
      report: { jobId: 7, counts: { combined: 1 } },
    });
    expect(component.showReport()).toBe(true);
    fixture.componentRef.setInput('isJobRunning', true);
    expect(component.showReport()).toBe(false);
  });

  it('exports exactly the rows the lists show for the current search and status', () => {
    const fixture = TestBed.createComponent(TransferActivityPanelComponent);
    const component = fixture.componentInstance;
    fixture.componentRef.setInput(
      'config',
      config([
        { ...row('failed'), name: 'bad.txt', error: 'denied' },
        { ...row('completed'), name: 'ok.txt' },
        { ...row('completed'), name: 'ok2.txt' },
      ])
    );
    expect(component.exportRows()).toHaveLength(3);
    component.statusFilter.set('completed');
    expect(component.exportRows().map(item => item.name)).toEqual(['ok.txt', 'ok2.txt']);
    component.searchTerm.set(' OK2 ');
    expect(component.exportRows().map(item => item.name)).toEqual(['ok2.txt']);
  });

  it('copies the visible rows as CSV and says how many it copied', () => {
    const fixture = TestBed.createComponent(TransferActivityPanelComponent);
    fixture.componentRef.setInput('config', config([row('checked'), row('failed')]));
    fixture.componentInstance.copyCsv();
    expect(copy).toHaveBeenCalledOnce();
    const csv = copy.mock.calls[0][0] as string;
    expect(csv.split('\n')).toHaveLength(3);
    expect(csv.startsWith('name,status,')).toBe(true);
    expect(showSuccess).toHaveBeenCalledOnce();
  });

  it('reports a failed copy and does nothing when no row is visible', () => {
    const fixture = TestBed.createComponent(TransferActivityPanelComponent);
    fixture.componentRef.setInput('config', config([]));
    fixture.componentInstance.copyCsv();
    expect(copy).not.toHaveBeenCalled();
    fixture.componentRef.setInput('config', config([row('checked')]));
    copy.mockReturnValue(false);
    fixture.componentInstance.copyCsv();
    expect(showError).toHaveBeenCalledOnce();
    expect(showSuccess).not.toHaveBeenCalled();
  });

  describe('title', () => {
    it('names what the section lists, not the job', () => {
      const titleOf = (jobType: TransferActivityPanelConfig['jobType']): string => {
        const fixture = TestBed.createComponent(TransferActivityPanelComponent);
        fixture.componentRef.setInput('config', { ...config([]), jobType });
        return fixture.componentInstance.titleKey();
      };
      expect(titleOf('sync')).toBe('shared.transferActivity.title');
      expect(titleOf('check')).toBe('shared.transferActivity.titleCheck');
      expect(titleOf('delete')).toBe('shared.transferActivity.titleDelete');
      expect(titleOf('mount')).toBe('shared.transferActivity.titleActivity');
    });
  });

  describe('tab row', () => {
    const panel = (
      completed: CompletedTransfer[],
      running = false
    ): TransferActivityPanelComponent => {
      const fixture = TestBed.createComponent(TransferActivityPanelComponent);
      fixture.componentRef.setInput('config', {
        ...config(completed),
        activeTransfers: running ? [{ name: 'a.txt' } as never] : [],
      });
      return fixture.componentInstance;
    };

    it('opens on the first tab and switches to the one picked', () => {
      const component = panel([row('completed')], true);
      expect(component.tabs().map(tab => tab.id)).toEqual(['active', 'recent']);
      expect(component.currentTab().id).toBe('active');
      component.selectTab('recent');
      expect(component.currentTab().id).toBe('recent');
    });

    it('falls back to the first tab when the picked one goes away', () => {
      const fixture = TestBed.createComponent(TransferActivityPanelComponent);
      const live = { ...config([row('completed')]), activeTransfers: [{ name: 'a.txt' } as never] };
      fixture.componentRef.setInput('config', live);
      fixture.componentInstance.selectTab('active');
      fixture.componentRef.setInput('config', config([row('completed')]));
      expect(fixture.componentInstance.currentTab().id).toBe('recent');
    });

    it('moves between the tabs with the arrow keys, Home and End', () => {
      const component = panel([row('completed')], true);
      const press = (key: string): void => {
        const strip = document.createElement('div');
        strip.append(document.createElement('button'), document.createElement('button'));
        const event = new KeyboardEvent('keydown', { key, cancelable: true });
        Object.defineProperty(event, 'currentTarget', { value: strip.children[0] });
        component['onTabKey'](event);
      };
      press('ArrowRight');
      expect(component.currentTab().id).toBe('recent');
      press('ArrowRight');
      expect(component.currentTab().id).toBe('active');
      press('ArrowLeft');
      expect(component.currentTab().id).toBe('recent');
      press('Home');
      expect(component.currentTab().id).toBe('active');
      press('End');
      expect(component.currentTab().id).toBe('recent');
      press('x');
      expect(component.currentTab().id).toBe('recent');
    });

    it('shows the bar for several tabs even without controls', () => {
      const fixture = TestBed.createComponent(TransferActivityPanelComponent);
      fixture.componentRef.setInput('config', {
        ...config([]),
        showHistory: false,
        activeTransfers: [],
        report: { jobId: 1, counts: { match: 1 } },
        completedTransfers: [],
      });
      // One tab (the report) and a search to press, so the bar shows.
      expect(fixture.componentInstance.showToolbar()).toBe(true);
    });
  });

  describe('title bar', () => {
    const idle = (
      overrides: Partial<TransferActivityPanelConfig>
    ): TransferActivityPanelComponent => {
      const fixture = TestBed.createComponent(TransferActivityPanelComponent);
      fixture.componentRef.setInput('config', { ...config([]), showHistory: false, ...overrides });
      return fixture.componentInstance;
    };

    it('is left out while it would hold nothing but its title', () => {
      expect(idle({}).showToolbar()).toBe(false);
    });

    it('appears once there is something to search, export or reset', () => {
      expect(idle({ completedTransfers: [row('completed')] }).showToolbar()).toBe(true);
      expect(idle({ showHistory: true }).showToolbar()).toBe(true);
      expect(idle({ activeTransfers: [{ name: 'a.txt' } as never] }).showToolbar()).toBe(true);
    });

    it('appears for the detail button even when nothing else is offered', () => {
      const fixture = TestBed.createComponent(TransferActivityPanelComponent);
      fixture.componentRef.setInput('config', { ...config([]), showHistory: false });
      expect(fixture.componentInstance.showToolbar()).toBe(false);
      fixture.componentRef.setInput('canOpenDetail', true);
      expect(fixture.componentInstance.showToolbar()).toBe(true);
    });

    it('stays while the search is open so it can be closed', () => {
      const panel = idle({});
      panel.toggleSearch();
      expect(panel.showToolbar()).toBe(true);
    });
  });

  describe('tabs', () => {
    const withReport = (
      report: NonNullable<TransferActivityPanelConfig['report']>,
      completed: CompletedTransfer[] = []
    ): TransferActivityPanelConfig => ({
      ...config(completed),
      showHistory: completed.length > 0,
      report,
    });
    const bisync = { jobId: 9, counts: { conflicts: 2 }, path1: 'a:', path2: 'b:' };
    const ids = (fixture: { componentInstance: TransferActivityPanelComponent }): string[] =>
      fixture.componentInstance.tabs().map(tab => tab.id);

    it('puts the conflicts of a finished bisync run first and carries their number', () => {
      const fixture = TestBed.createComponent(TransferActivityPanelComponent);
      fixture.componentRef.setInput('config', withReport(bisync, [row('completed')]));
      expect(ids(fixture)).toEqual(['conflicts', 'recent']);
      expect(fixture.componentInstance.tabs()[0].count).toBe(2);
      expect(fixture.componentInstance.conflictsTarget()).toEqual({
        jobId: 9,
        path1: 'a:',
        path2: 'b:',
      });
    });

    it('keeps the view it would have shown anyway beside the conflicts', () => {
      const fixture = TestBed.createComponent(TransferActivityPanelComponent);
      fixture.componentRef.setInput('config', withReport(bisync));
      fixture.componentRef.setInput('isJobRunning', false);
      expect(ids(fixture)).toEqual(['conflicts', 'active']);
    });

    it('offers no conflicts for a dry run, a running job, or paths it does not know', () => {
      const fixture = TestBed.createComponent(TransferActivityPanelComponent);
      fixture.componentRef.setInput('config', withReport({ ...bisync, dryRun: true }));
      expect(ids(fixture)).not.toContain('conflicts');
      fixture.componentRef.setInput('config', withReport({ ...bisync, path2: undefined }));
      expect(ids(fixture)).not.toContain('conflicts');
      fixture.componentRef.setInput('config', withReport(bisync));
      fixture.componentRef.setInput('isJobRunning', true);
      expect(ids(fixture)).not.toContain('conflicts');
      fixture.componentRef.setInput('config', withReport({ ...bisync, counts: { conflicts: 0 } }));
      fixture.componentRef.setInput('isJobRunning', false);
      expect(ids(fixture)).not.toContain('conflicts');
    });

    it('lists the file report and the history of a finished sync, and no conflicts tab', () => {
      const fixture = TestBed.createComponent(TransferActivityPanelComponent);
      fixture.componentRef.setInput(
        'config',
        withReport({ jobId: 3, counts: { combined: 4 } }, [row('completed')])
      );
      expect(ids(fixture)).toEqual(['report', 'recent']);
    });

    it('does not treat a report that only holds conflicts as a file report', () => {
      const fixture = TestBed.createComponent(TransferActivityPanelComponent);
      fixture.componentRef.setInput('config', withReport({ ...bisync, dryRun: true }));
      expect(fixture.componentInstance.showReport()).toBe(false);
    });

    it('offers active work and history while a job runs, and a single view otherwise', () => {
      const fixture = TestBed.createComponent(TransferActivityPanelComponent);
      fixture.componentRef.setInput('config', {
        ...config([row('completed')]),
        activeTransfers: [{ name: 'x' } as never],
      });
      expect(ids(fixture)).toEqual(['active', 'recent']);
      fixture.componentRef.setInput('config', config([row('completed')]));
      expect(ids(fixture)).toEqual(['recent']);
      fixture.componentRef.setInput('config', { ...config([]), showHistory: false });
      expect(ids(fixture)).toEqual(['active']);
    });
  });
});
