import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { Observable, of } from 'rxjs';
import { CompletedTransfer, ResolveState } from '@app/types';
import { CompletedTransfersTableComponent } from './completed-transfers-table.component';
import { CheckResultsTableComponent } from './check-results-table.component';
import { ActiveTransfersTableComponent } from './active-transfers-table.component';
import { TransferOperationsService } from './transfer-operations.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { ModalService } from 'src/app/services/ui/modal.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import type { CheckCompareData } from './check-compare-dialog.component';
import type { CheckDirection } from './activity.utils';

const row = (i: number, status: CompletedTransfer['status'] = 'completed'): CompletedTransfer => ({
  jobid: 7,
  name: `folder/file-${i}.txt`,
  size: 100,
  bytes: 100,
  checked: false,
  error: '',
  status,
  srcFs: 'drive:photos',
  dstFs: 'backup:archive',
});
const resolved: ResolveState = {
  status: 'Completed',
  percentage: 100,
  isPreparing: false,
  bytes: 100,
  size: 100,
  speed: 0,
  eta: 0,
};

describe('activity tables', () => {
  const copyFile = vi.fn().mockResolvedValue('job');
  const resolveCheck = vi.fn().mockResolvedValue('job');
  const ops = { copyFile, resolveCheck };
  const openCheckCompare = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        { provide: NotificationService, useValue: { showSuccess: vi.fn(), showError: vi.fn() } },
        { provide: ModalService, useValue: { openCheckCompare } },
        {
          provide: PathService,
          useValue: { extractName: (path: string): string => path.split('/').at(-1) || '' },
        },
      ],
    });
    for (const component of [
      CompletedTransfersTableComponent,
      CheckResultsTableComponent,
      ActiveTransfersTableComponent,
    ]) {
      TestBed.overrideComponent(component, {
        set: { template: '', providers: [{ provide: TransferOperationsService, useValue: ops }] },
      });
    }
  });

  it('formats only loaded history rows and preserves the loaded window through polling', () => {
    const fixture = TestBed.createComponent(CompletedTransfersTableComponent);
    const rows = Array.from({ length: 125 }, (_, i) => row(i));
    fixture.componentRef.setInput('transfers', rows);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    expect(component['processedItems']()).toHaveLength(50);
    component.onScroll({
      target: { scrollHeight: 1000, scrollTop: 900, clientHeight: 100 },
    } as unknown as Event);
    expect(component['processedItems']()).toHaveLength(100);
    fixture.componentRef.setInput(
      'transfers',
      rows.map(item => ({ ...item }))
    );
    expect(component['processedItems']()).toHaveLength(100);
    fixture.componentRef.setInput('searchTerm', 'BACKUP:ARCHIVE');
    expect(component['processedItems']()).toHaveLength(50);
    fixture.componentRef.setInput(
      'transfers',
      rows.map(item => ({ ...item, jobid: 8 }))
    );
    expect(component.displayLimit()).toBe(50);
  });

  it('combines case-insensitive path/error search with the current repair status', () => {
    const fixture = TestBed.createComponent(CompletedTransfersTableComponent);
    fixture.componentRef.setInput('transfers', [
      row(0),
      row(1, 'failed'),
      { ...row(2, 'partial'), resolveState: resolved },
      { ...row(3, 'partial'), error: 'Permission denied' },
    ]);
    fixture.componentRef.setInput('statusFilter', 'partial');
    fixture.detectChanges();
    expect(fixture.componentInstance['processedItems']().map(item => item.name)).toEqual([
      'folder/file-3.txt',
    ]);
    fixture.componentRef.setInput('searchTerm', ' DENIED ');
    expect(fixture.componentInstance['processedItems']()).toHaveLength(1);
  });

  it('keeps original failure data separate from the repair presentation', async () => {
    const fixture = TestBed.createComponent(CompletedTransfersTableComponent);
    const original = { ...row(0, 'failed'), error: 'original failure', resolveState: resolved };
    fixture.componentRef.setInput('transfers', [original]);
    fixture.detectChanges();
    const item = fixture.componentInstance['processedItems']()[0];
    expect(item.status).toBe('failed');
    expect(item.error).toBe('original failure');
    expect(item.displayStatus).toBe('completed');
    expect(item.displayError).toBe('');
    expect(original.status).toBe('failed');
    await fixture.componentInstance.onResolve(item);
    expect(copyFile).not.toHaveBeenCalled();
  });

  it('filters checked and completed records of the same file independently', () => {
    const fixture = TestBed.createComponent(CompletedTransfersTableComponent);
    const checked = { ...row(0, 'checked'), checked: true, bytes: 0, what: 'checking' as const };
    const completed = { ...row(0), what: 'transferring' as const };
    fixture.componentRef.setInput('transfers', [checked, completed]);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    expect(component['processedItems']()).toHaveLength(2);
    fixture.componentRef.setInput('statusFilter', 'checked');
    expect(component['processedItems']().map(item => item.status)).toEqual(['checked']);
    fixture.componentRef.setInput('statusFilter', 'completed');
    expect(component['processedItems']().map(item => item.status)).toEqual(['completed']);
  });

  it('distinguishes deleting from checking within a sync history and keeps row IDs stable', () => {
    const fixture = TestBed.createComponent(CompletedTransfersTableComponent);
    fixture.componentRef.setInput('transfers', [{ ...row(0), what: 'deleting' }]);
    fixture.detectChanges();
    const original = fixture.componentInstance['processedItems']()[0];
    expect(original.badge.icon).toBe('trash');
    expect(original.badge.text).toBe('common.delete');
    fixture.componentRef.setInput('transfers', [{ ...row(0, 'failed'), what: 'deleting' }]);
    expect(fixture.componentInstance['processedItems']()[0].uniqueId).toBe(original.uniqueId);
  });

  it('keeps comparison results stable and refuses non-actionable repairs', async () => {
    const fixture = TestBed.createComponent(CheckResultsTableComponent);
    fixture.componentRef.setInput('transfers', [row(0, 'checked')]);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const item = component['processedItems']()[0];
    expect(component['processedItems']()[0].status).toBe('checked');
    fixture.componentRef.setInput('statusFilter', 'failed');
    expect(component['processedItems']()).toHaveLength(0);
    await component.onResolve({ ...item, status: 'failed' });
    await component.onResolve({ ...item, status: 'missing_dst', srcFs: '' });
    expect(resolveCheck).not.toHaveBeenCalled();
  });

  it('delegates file retries and reverse check repairs to the same copy service', async () => {
    const failed = { ...row(0, 'failed'), uniqueId: 'failed' };
    const completed = TestBed.createComponent(CompletedTransfersTableComponent).componentInstance;
    await completed.onResolve(failed);
    expect(copyFile).toHaveBeenLastCalledWith(failed);

    const missing = { ...row(1, 'missing_src'), uniqueId: 'missing' };
    const check = TestBed.createComponent(CheckResultsTableComponent).componentInstance;
    await check.onResolve(missing);
    expect(resolveCheck).toHaveBeenLastCalledWith(missing, 'toSource');
    expect(completed.resolvingIds().size).toBe(0);
    expect(check.resolvingIds().size).toBe(0);
  });

  describe('card titles', () => {
    it('splits the name into folders and file for the card title', () => {
      const fixture = TestBed.createComponent(CompletedTransfersTableComponent);
      fixture.componentRef.setInput('transfers', [row(3)]);
      fixture.detectChanges();
      const item = fixture.componentInstance['processedItems']()[0];
      expect([item.dir, item.base]).toEqual(['folder/', 'file-3.txt']);
    });
  });

  describe('check differences', () => {
    const open = (rows: CompletedTransfer[]): CheckResultsTableComponent => {
      const fixture = TestBed.createComponent(CheckResultsTableComponent);
      fixture.componentRef.setInput('transfers', rows);
      fixture.detectChanges();
      return fixture.componentInstance;
    };
    const rows = [
      row(0, 'missing_dst'),
      row(1, 'missing_src'),
      row(2, 'partial'),
      row(3, 'checked'),
    ];

    it('offers a decision only for differences that are still open', () => {
      const component = open([...rows, { ...row(4, 'partial'), resolveState: resolved }]);
      expect(component['openItems']().map(item => item.name)).toEqual([
        'folder/file-0.txt',
        'folder/file-1.txt',
        'folder/file-2.txt',
      ]);
      expect(component['processedItems']().map(item => item.resolution?.directionKey)).toEqual([
        'shared.transferActivity.direction.toDestination',
        'shared.transferActivity.direction.toSource',
        'shared.transferActivity.direction.choose',
        undefined,
        undefined,
      ]);
    });

    it('counts a selection by direction and selects every open difference at once', () => {
      const component = open(rows);
      component['toggleAll'](true);
      expect(component['selectedCounts']()).toEqual({ toDestination: 1, toSource: 1, choose: 1 });
      expect(component['allSelected']()).toBe(true);
      component['toggle'](component['openItems']()[0].uniqueId, false);
      expect(component['selectedItems']()).toHaveLength(2);
      component['clearSelection']();
      expect(component['selectedItems']()).toHaveLength(0);
    });

    it('applies the one-way changes of a selection and leaves conflicts for review', async () => {
      const component = open(rows);
      component['toggleAll'](true);
      await component['applyOneWay']();
      expect(resolveCheck).toHaveBeenCalledTimes(2);
      expect(resolveCheck).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'missing_dst' }),
        'toDestination'
      );
      expect(resolveCheck).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'missing_src' }),
        'toSource'
      );
      expect(component['selectedItems']().map(item => item.status)).toEqual(['partial']);
    });

    it('keeps a failed copy selected and still starts the others', async () => {
      resolveCheck.mockRejectedValueOnce(new Error('denied'));
      const component = open(rows);
      component['toggleAll'](true);
      await component['applyOneWay']();
      expect(resolveCheck).toHaveBeenCalledTimes(2);
      expect(component['selectedItems']().map(item => item.status)).toEqual([
        'missing_dst',
        'partial',
      ]);
    });

    /** Plays the user's answers, one per file in the order asked; `null` skips the file. */
    const answer = (...answers: (CheckDirection | null)[]): void => {
      openCheckCompare.mockImplementation(
        (data: CheckCompareData): { afterClosed: () => Observable<undefined> } => {
          answers.forEach((direction, index) => direction && data.apply(index, direction));
          return { afterClosed: () => of(undefined) };
        }
      );
    };

    it('asks about the selected conflicts in one dialog and starts each answered change', async () => {
      const conflicts = [row(2, 'partial'), row(3, 'partial'), row(4, 'partial')];
      answer('toSource', null, 'toDestination');
      const component = open(conflicts);
      component['toggleAll'](true);
      await component['reviewConflicts']();
      expect(openCheckCompare).toHaveBeenCalledOnce();
      expect(
        openCheckCompare.mock.calls[0][0].entries.map((entry: { name: string }) => entry.name)
      ).toEqual(['folder/file-2.txt', 'folder/file-3.txt', 'folder/file-4.txt']);
      await vi.waitFor(() => expect(resolveCheck).toHaveBeenCalledTimes(2));
      expect(resolveCheck).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'folder/file-2.txt' }),
        'toSource'
      );
      expect(resolveCheck).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'folder/file-4.txt' }),
        'toDestination'
      );
      expect(component['bulkBusy']()).toBe(false);
    });

    it('asks which side wins before it copies a single differing file', async () => {
      answer('toDestination');
      const component = open([row(2, 'partial')]);
      await component.onResolve(component['processedItems']()[0]);
      expect(openCheckCompare.mock.calls[0][0].entries).toHaveLength(1);
      await vi.waitFor(() =>
        expect(resolveCheck).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'folder/file-2.txt' }),
          'toDestination'
        )
      );
    });

    it('copies nothing when the dialog is closed without an answer', async () => {
      answer();
      const component = open([row(2, 'partial')]);
      await component.onResolve(component['processedItems']()[0]);
      expect(resolveCheck).not.toHaveBeenCalled();
    });
  });

  it('shows and searches live non-transfer work without manufacturing transfer rows', () => {
    const fixture = TestBed.createComponent(ActiveTransfersTableComponent);
    fixture.componentRef.setInput('transfers', []);
    fixture.componentRef.setInput('checks', ['folder/Ünicode.txt', 'other.txt']);
    fixture.componentRef.setInput('jobType', 'delete');
    fixture.detectChanges();
    const component = fixture.componentInstance;
    expect(component['checkLabel']()).toContain('deleting');
    fixture.componentRef.setInput('searchTerm', ' ÜNICODE ');
    expect(component['filteredChecks']()).toEqual(['folder/Ünicode.txt']);
    expect(component['enrichedTransfers']()).toEqual([]);
    fixture.componentRef.setInput('jobType', 'cryptcheck');
    expect(component['checkLabel']()).toContain('checking');
  });
});
