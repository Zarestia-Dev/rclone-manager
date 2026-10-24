import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { CompletedTransfer, ResolveState } from '@app/types';
import { CompletedTransfersTableComponent } from './completed-transfers-table.component';
import { CheckResultsTableComponent } from './check-results-table.component';
import { ActiveTransfersTableComponent } from './active-transfers-table.component';
import { TransferOperationsService } from './transfer-operations.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';

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
  const ops = { copyFile };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        { provide: NotificationService, useValue: { showSuccess: vi.fn(), showError: vi.fn() } },
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
    expect(copyFile).not.toHaveBeenCalled();
  });

  it('delegates file retries and reverse check repairs to the same copy service', async () => {
    const failed = { ...row(0, 'failed'), uniqueId: 'failed' };
    const completed = TestBed.createComponent(CompletedTransfersTableComponent).componentInstance;
    await completed.onResolve(failed);
    expect(copyFile).toHaveBeenLastCalledWith(failed);

    const missing = { ...row(1, 'missing_src'), uniqueId: 'missing' };
    const check = TestBed.createComponent(CheckResultsTableComponent).componentInstance;
    await check.onResolve(missing);
    expect(copyFile).toHaveBeenLastCalledWith(missing, true);
    expect(completed.resolvingIds().size).toBe(0);
    expect(check.resolvingIds().size).toBe(0);
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
