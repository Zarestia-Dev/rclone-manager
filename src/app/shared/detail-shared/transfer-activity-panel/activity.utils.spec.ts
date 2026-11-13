import { describe, expect, it } from 'vitest';
import { CompletedTransfer, ResolveState } from '@app/types';
import {
  activityBadge,
  activityCsv,
  activityError,
  activityStatusBadge,
  canResolveCheck,
  canCopyFailedTransfer,
  checkResolution,
  checkRowId,
  compareVersions,
  displayPath,
  effectiveTransferStatus,
  FileVersion,
  isDeleteActivity,
  matchesActivitySearch,
  resolutionCounts,
  splitPath,
} from './activity.utils';

const transfer: CompletedTransfer = {
  jobid: 7,
  name: 'folder/Ünicode: file.txt',
  size: 100,
  bytes: 0,
  checked: false,
  error: '',
  status: 'partial',
  srcFs: 'drive:photos',
  dstFs: 'backup:archive',
};

describe('activity filtering and actions', () => {
  it('derives badges from the operation and repair outcome without separate mode flags', () => {
    expect(activityBadge(transfer, 'check').text).toBe('shared.transferActivity.status.differ');
    expect(activityBadge(transfer, 'copy').text).toBe('shared.transferActivity.status.partial');
    expect(activityBadge({ ...transfer, status: 'completed', what: 'deleting' }, 'sync').icon).toBe(
      'trash'
    );
    expect(activityBadge({ ...transfer, status: 'failed', what: 'deleting' }, 'sync').text).toBe(
      'shared.transferActivity.status.failed'
    );
  });

  it('searches names, both roots, errors and activity without requiring optional fields', () => {
    for (const search of ['ünicode:', 'drive:photos', 'backup:archive']) {
      expect(matchesActivitySearch(transfer, search)).toBe(true);
    }
    expect(matchesActivitySearch({ name: '', error: 'Permission DENIED' }, 'denied')).toBe(true);
    expect(matchesActivitySearch({ name: '', what: 'deleting' }, 'delet')).toBe(true);
    expect(matchesActivitySearch({ name: '' }, 'missing')).toBe(false);
    expect(matchesActivitySearch({ name: '' }, '')).toBe(true);
  });

  it('uses repair outcomes for status while preserving the original report', () => {
    const resolveState: ResolveState = {
      status: 'Completed',
      percentage: 100,
      isPreparing: false,
      bytes: 100,
      size: 100,
      speed: 0,
      eta: 0,
    };
    expect(effectiveTransferStatus({ ...transfer, resolveState })).toBe('completed');
    expect(canResolveCheck({ ...transfer, resolveState })).toBe(false);
    expect(
      canResolveCheck({ ...transfer, resolveState: { ...resolveState, status: 'Failed' } })
    ).toBe(true);
    expect(
      effectiveTransferStatus({ ...transfer, resolveState: { ...resolveState, status: 'Failed' } })
    ).toBe('failed');
    expect(effectiveTransferStatus(transfer)).toBe('partial');
  });

  it('hides an original error after successful repair and shows a new repair error', () => {
    const resolveState: ResolveState = {
      status: 'Completed',
      percentage: 100,
      isPreparing: false,
      bytes: 100,
      size: 100,
      speed: 0,
      eta: 0,
    };
    const item: CompletedTransfer = {
      ...transfer,
      error: 'original failure',
      resolveState,
    };
    expect(activityError(item)).toBe('');
    expect(item.error).toBe('original failure');
    expect(
      activityError({
        ...item,
        resolveState: { ...resolveState, status: 'Failed', error: 'retry failed' },
      })
    ).toBe('retry failed');
    expect(activityError(transfer)).toBe('');
  });

  it('keeps checked and completed as different result badges', () => {
    expect(activityStatusBadge('checked', 'sync').text).toBe(
      'shared.transferActivity.status.checked'
    );
    expect(activityStatusBadge('completed', 'sync').text).toBe(
      'shared.transferActivity.status.completed'
    );
    expect(
      activityBadge({ ...transfer, status: 'completed', what: 'checking' }, 'delete').icon
    ).toBe('check-circle');
  });

  it('offers repair only for differences with known source and destination roots', () => {
    for (const status of ['missing_src', 'missing_dst', 'partial'] as const) {
      expect(canResolveCheck({ ...transfer, status })).toBe(true);
    }
    for (const status of ['failed', 'checked', 'completed'] as const) {
      expect(canResolveCheck({ ...transfer, status })).toBe(false);
    }
    expect(canResolveCheck({ ...transfer, srcFs: '' })).toBe(false);
    expect(canResolveCheck({ ...transfer, dstFs: undefined })).toBe(false);
  });

  it('only offers copying a failed transfer when the operation and file roots support it', () => {
    const failed: CompletedTransfer = { ...transfer, status: 'failed' };
    expect(canCopyFailedTransfer(failed, 'copy')).toBe(true);
    expect(
      canCopyFailedTransfer(
        {
          ...failed,
          resolveState: {
            status: 'Completed',
            percentage: 100,
            isPreparing: false,
            bytes: 100,
            size: 100,
            speed: 0,
            eta: 0,
          },
        },
        'copy'
      )
    ).toBe(false);
    expect(canCopyFailedTransfer({ ...failed, what: 'deleting' }, 'sync')).toBe(false);
    for (const operation of ['delete', 'cleanup', 'rmdirs', 'hash'] as const) {
      expect(canCopyFailedTransfer(failed, operation)).toBe(false);
    }
    expect(canCopyFailedTransfer({ ...failed, dstFs: '' }, 'copy')).toBe(false);
  });

  it('uses explicit rclone activity before falling back to the job type', () => {
    expect(isDeleteActivity({ what: 'deleting' }, 'sync')).toBe(true);
    expect(isDeleteActivity({ what: 'checking' }, 'delete')).toBe(false);
    expect(isDeleteActivity({}, 'delete')).toBe(true);
    expect(isDeleteActivity({}, 'sync')).toBe(false);
  });
});

describe('check resolution', () => {
  const at = (
    status: CompletedTransfer['status'],
    extra: Partial<CompletedTransfer> = {}
  ): CompletedTransfer => ({
    ...transfer,
    status,
    ...extra,
  });
  const done: ResolveState = {
    status: 'Completed',
    percentage: 100,
    isPreparing: false,
    bytes: 1,
    size: 1,
    speed: 0,
    eta: 0,
  };

  it('names the direction each kind of difference calls for', () => {
    expect(checkResolution(at('missing_dst'))).toBe('toDestination');
    expect(checkResolution(at('missing_src'))).toBe('toSource');
    expect(checkResolution(at('partial'))).toBe('choose');
  });

  it('offers nothing for matches, failures, repaired files or rows without both roots', () => {
    expect(checkResolution(at('checked'))).toBeNull();
    expect(checkResolution(at('failed'))).toBeNull();
    expect(checkResolution(at('partial', { resolveState: done }))).toBeNull();
    expect(checkResolution(at('missing_dst', { srcFs: '' }))).toBeNull();
    expect(checkResolution(at('missing_dst', { dstFs: undefined }))).toBeNull();
  });

  it('counts a mixed list by direction', () => {
    expect(
      resolutionCounts([
        at('missing_dst'),
        at('missing_dst'),
        at('missing_src'),
        at('partial'),
        at('checked'),
      ])
    ).toEqual({ toDestination: 2, toSource: 1, choose: 1 });
    expect(resolutionCounts([])).toEqual({ toDestination: 0, toSource: 0, choose: 0 });
  });

  it('keeps row ids apart per job, pair and file', () => {
    expect(checkRowId(transfer)).toBe(checkRowId({ ...transfer }));
    expect(checkRowId(transfer)).not.toBe(checkRowId({ ...transfer, jobid: 8 }));
    expect(checkRowId(transfer)).not.toBe(checkRowId({ ...transfer, dstFs: 'other:archive' }));
    expect(checkRowId(transfer)).not.toBe(checkRowId({ ...transfer, name: 'other.txt' }));
  });
});

describe('compareVersions', () => {
  const version = (size: number, modTime: string | null): FileVersion => ({ size, modTime });

  it('tags the later and the larger side', () => {
    expect(
      compareVersions(version(10, '2026-11-07T10:00:00Z'), version(20, '2026-11-03T10:00:00Z'))
    ).toEqual({ newer: 'src', larger: 'dst' });
    expect(
      compareVersions(version(30, '2026-01-01T00:00:00Z'), version(5, '2026-02-01T00:00:00Z'))
    ).toEqual({ newer: 'dst', larger: 'src' });
  });

  it('tags nothing that is equal or unknown', () => {
    expect(
      compareVersions(version(5, '2026-01-01T00:00:00Z'), version(5, '2026-01-01T00:00:00Z'))
    ).toEqual({ newer: null, larger: null });
    expect(compareVersions(version(-1, null), version(7, 'not a date'))).toEqual({
      newer: null,
      larger: null,
    });
    expect(compareVersions(null, version(7, null))).toEqual({ newer: null, larger: null });
    expect(compareVersions(null, null)).toEqual({ newer: null, larger: null });
  });
});

describe('displayPath', () => {
  it('joins a side root and a file name without doubling separators', () => {
    expect(displayPath('drive:photos', 'a/b.txt')).toBe('drive:photos/a/b.txt');
    expect(displayPath('drive:', 'b.txt')).toBe('drive:b.txt');
    expect(displayPath('/home/me/', 'b.txt')).toBe('/home/me/b.txt');
    expect(displayPath('C:\\data\\', 'b.txt')).toBe('C:\\data\\b.txt');
    expect(displayPath('drive:photos', '')).toBe('drive:photos');
  });
});

describe('splitPath', () => {
  it('keeps the folders and the name apart', () => {
    expect(splitPath('2025/Trip/IMG_1.CR3')).toEqual({ dir: '2025/Trip/', base: 'IMG_1.CR3' });
    expect(splitPath('notes.txt')).toEqual({ dir: '', base: 'notes.txt' });
    expect(splitPath('folder/')).toEqual({ dir: 'folder/', base: '' });
    expect(splitPath('')).toEqual({ dir: '', base: '' });
  });
});

describe('activityCsv', () => {
  it('writes a header and one line per file', () => {
    const csv = activityCsv([
      {
        ...transfer,
        name: 'a.txt',
        status: 'completed',
        size: 10,
        bytes: 10,
        error: '',
        srcFs: 'drive:',
        dstFs: '/backup',
        completedAt: '2026-11-08',
      },
    ]);
    expect(csv).toBe(
      'name,status,source,destination,size,bytes,completed,error\na.txt,completed,drive:,/backup,10,10,2026-11-08,'
    );
  });

  it('quotes commas, quotes and line breaks so a cell stays one cell', () => {
    const csv = activityCsv([
      {
        ...transfer,
        name: 'a, "b".txt',
        status: 'failed',
        srcFs: undefined,
        dstFs: undefined,
        size: 10,
        bytes: 10,
        error: 'line1\nline2',
      },
    ]);
    expect(csv.split('\n').slice(1).join('\n')).toBe(
      '"a, ""b"".txt",failed,,,10,10,,"line1\nline2"'
    );
  });

  it('is only a header for no rows', () => {
    expect(activityCsv([])).toBe('name,status,source,destination,size,bytes,completed,error');
  });
});
