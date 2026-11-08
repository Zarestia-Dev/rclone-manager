import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { Observable, of } from 'rxjs';
import { BisyncConflict } from '@app/types';
import type { CheckCompareData } from '../transfer-activity-panel/check-compare-dialog.component';
import type { CheckDirection } from '../transfer-activity-panel/activity.utils';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { RemoteFileOperationsService } from 'src/app/services/remote/remote-file-operations.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { ModalService } from 'src/app/services/ui/modal.service';
import { BackendTranslationService } from 'src/app/services/i18n/backend-translation.service';
import { BisyncConflictsComponent } from './bisync-conflicts.component';

const conflict = (name: string): BisyncConflict => ({
  path: name,
  path1Now: `${name}.conflict1`,
  path2Now: `${name}.conflict2`,
});

describe('BisyncConflictsComponent', () => {
  const getJobReport = vi.fn();
  const resolveBisyncConflict = vi.fn();
  const openCheckCompare = vi.fn();
  const showSuccess = vi.fn();
  const showError = vi.fn();
  const translateBackendMessage = vi.fn((message: string) => `translated: ${message}`);

  const conflicts = [conflict('notes/a.md'), conflict('notes/b.md'), conflict('notes/c.md')];

  /** Plays the user's answers, one per file in the order asked; `null` skips the file. */
  const answer = (...answers: (CheckDirection | null)[]): void => {
    openCheckCompare.mockImplementation(
      (data: CheckCompareData): { afterClosed: () => Observable<undefined> } => {
        answers.forEach((direction, index) => direction && data.apply(index, direction));
        return { afterClosed: () => of(undefined) };
      }
    );
  };

  const create = async (jobId = 5): Promise<ComponentFixture<BisyncConflictsComponent>> => {
    const fixture = TestBed.createComponent(BisyncConflictsComponent);
    fixture.componentRef.setInput('jobId', jobId);
    fixture.componentRef.setInput('path1', 'gdrive:Notes');
    fixture.componentRef.setInput('path2', '/home/me/Notes');
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  };
  interface Row {
    conflict: BisyncConflict;
    settledKeep: 'path1' | 'path2' | null;
    resolving: boolean;
  }
  const rows = (fixture: ComponentFixture<BisyncConflictsComponent>): Row[] =>
    fixture.componentInstance['rows']() as Row[];

  beforeEach(() => {
    vi.clearAllMocks();
    getJobReport.mockResolvedValue({ conflicts });
    resolveBisyncConflict.mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        { provide: JobManagementService, useValue: { getJobReport } },
        { provide: RemoteFileOperationsService, useValue: { resolveBisyncConflict } },
        { provide: NotificationService, useValue: { showSuccess, showError } },
        { provide: ModalService, useValue: { openCheckCompare } },
        { provide: BackendTranslationService, useValue: { translateBackendMessage } },
      ],
    });
    TestBed.overrideComponent(BisyncConflictsComponent, { set: { template: '', imports: [] } });
  });

  it('lists the conflicts the job reported, all of them still open', async () => {
    const fixture = await create();
    expect(getJobReport).toHaveBeenCalledWith(5);
    expect(rows(fixture).map(row => row.conflict.path)).toEqual([
      'notes/a.md',
      'notes/b.md',
      'notes/c.md',
    ]);
    expect(fixture.componentInstance['openRows']()).toHaveLength(3);
  });

  it('narrows the list by the search text without caring for case', async () => {
    const fixture = await create();
    fixture.componentRef.setInput('searchTerm', ' B.MD ');
    expect(rows(fixture).map(row => row.conflict.path)).toEqual(['notes/b.md']);
  });

  it('opens one dialog with the version of each path under the name it has now', async () => {
    answer();
    const fixture = await create();
    await fixture.componentInstance['resolveOne'](conflicts[0]);
    expect(openCheckCompare).toHaveBeenCalledOnce();
    expect(openCheckCompare.mock.calls[0][0]).toEqual({
      bisync: true,
      entries: [
        {
          name: 'notes/a.md',
          src: { fs: 'gdrive:Notes', path: 'notes/a.md.conflict1' },
          dst: { fs: '/home/me/Notes', path: 'notes/a.md.conflict2' },
          target: {
            src: { fs: 'gdrive:Notes', path: 'notes/a.md' },
            dst: { fs: '/home/me/Notes', path: 'notes/a.md' },
          },
        },
      ],
      apply: expect.any(Function),
    });
    expect(resolveBisyncConflict).not.toHaveBeenCalled();
    expect(fixture.componentInstance['busy']()).toBe(false);
  });

  it('keeps the version of the path the user picked and marks the conflict settled', async () => {
    answer('toSource');
    const fixture = await create();
    await fixture.componentInstance['resolveOne'](conflicts[0]);
    await vi.waitFor(() => expect(rows(fixture)[0].settledKeep).toBe('path2'));
    expect(resolveBisyncConflict).toHaveBeenCalledWith(
      'gdrive:Notes',
      '/home/me/Notes',
      conflicts[0],
      'path2',
      'dashboard'
    );
    expect(fixture.componentInstance['openRows']().map(row => row.conflict.path)).toEqual([
      'notes/b.md',
      'notes/c.md',
    ]);
    expect(showSuccess).toHaveBeenCalledOnce();

    answer('toDestination');
    await fixture.componentInstance['resolveOne'](conflicts[1]);
    await vi.waitFor(() => expect(resolveBisyncConflict).toHaveBeenCalledTimes(2));
    expect(resolveBisyncConflict).toHaveBeenLastCalledWith(
      'gdrive:Notes',
      '/home/me/Notes',
      conflicts[1],
      'path1',
      'dashboard'
    );
  });

  it('does not wait for a change to finish before the dialog goes on', async () => {
    let finish: () => void = () => undefined;
    resolveBisyncConflict.mockImplementationOnce(
      () => new Promise<void>(resolve => (finish = resolve))
    );
    answer('toDestination', 'toSource');
    const fixture = await create();
    fixture.componentInstance['toggleAll'](true);
    await fixture.componentInstance['reviewSelected']();
    // Both answers were handed on although the first change is still running.
    await vi.waitFor(() => expect(resolveBisyncConflict).toHaveBeenCalledTimes(2));
    expect(rows(fixture)[0].resolving).toBe(true);
    finish();
    await vi.waitFor(() => expect(rows(fixture)[0].settledKeep).toBe('path1'));
  });

  it('shows what went wrong and leaves the conflict open when the files could not be changed', async () => {
    answer('toDestination');
    resolveBisyncConflict.mockRejectedValue(new Error('{"key":"stepFailed"}'));
    const fixture = await create();
    await fixture.componentInstance['resolveOne'](conflicts[0]);
    await vi.waitFor(() =>
      expect(showError).toHaveBeenCalledWith('translated: {"key":"stepFailed"}')
    );
    expect(rows(fixture)[0].settledKeep).toBeNull();
    expect(rows(fixture)[0].resolving).toBe(false);
  });

  describe('selection', () => {
    it('selects every open conflict at once and counts only those', async () => {
      const fixture = await create();
      const component = fixture.componentInstance;
      component['toggleAll'](true);
      expect(component['selectedRows']().map(row => row.conflict.path)).toEqual([
        'notes/a.md',
        'notes/b.md',
        'notes/c.md',
      ]);
      expect(component['allSelected']()).toBe(true);
      component['toggle']('notes/a.md', false);
      expect(component['selectedRows']()).toHaveLength(2);
      expect(component['allSelected']()).toBe(false);
      component['clearSelection']();
      expect(component['selectedRows']()).toHaveLength(0);
    });

    it('reviews the selected conflicts in one dialog and skips on request', async () => {
      answer(null, 'toDestination');
      const fixture = await create();
      fixture.componentInstance['toggleAll'](true);
      await fixture.componentInstance['reviewSelected']();
      expect(openCheckCompare).toHaveBeenCalledOnce();
      expect(
        openCheckCompare.mock.calls[0][0].entries.map((entry: { name: string }) => entry.name)
      ).toEqual(['notes/a.md', 'notes/b.md', 'notes/c.md']);
      await vi.waitFor(() => expect(resolveBisyncConflict).toHaveBeenCalledOnce());
      expect(resolveBisyncConflict).toHaveBeenCalledWith(
        'gdrive:Notes',
        '/home/me/Notes',
        conflicts[1],
        'path1',
        'dashboard'
      );
    });

    it('asks nothing when nothing is selected', async () => {
      const fixture = await create();
      await fixture.componentInstance['reviewSelected']();
      expect(openCheckCompare).not.toHaveBeenCalled();
    });

    it('drops a conflict from the selection once it is settled', async () => {
      answer('toDestination');
      const fixture = await create();
      fixture.componentInstance['toggleAll'](true);
      await fixture.componentInstance['resolveOne'](conflicts[0]);
      await vi.waitFor(() => expect(rows(fixture)[0].settledKeep).toBe('path1'));
      expect(fixture.componentInstance['selection']().has('notes/a.md')).toBe(false);
      expect(fixture.componentInstance['selection']().has('notes/b.md')).toBe(true);
    });
  });

  it('shows an empty, failed state instead of stale rows when the report cannot be read', async () => {
    getJobReport.mockRejectedValue(new Error('gone'));
    const fixture = await create();
    expect(fixture.componentInstance['failed']()).toBe(true);
    expect(rows(fixture)).toEqual([]);
  });

  it('treats a report without conflicts as none', async () => {
    getJobReport.mockResolvedValue(null);
    const fixture = await create();
    expect(rows(fixture)).toEqual([]);
    expect(fixture.componentInstance['failed']()).toBe(false);
  });

  it('forgets what was settled and selected when another job is shown', async () => {
    answer('toDestination');
    const fixture = await create();
    fixture.componentInstance['toggleAll'](true);
    await fixture.componentInstance['resolveOne'](conflicts[0]);
    await vi.waitFor(() => expect(rows(fixture)[0].settledKeep).toBe('path1'));
    fixture.componentRef.setInput('jobId', 6);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(getJobReport).toHaveBeenLastCalledWith(6);
    expect(rows(fixture)[0].settledKeep).toBeNull();
    expect(fixture.componentInstance['selection']().size).toBe(0);
  });
});
