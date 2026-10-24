import { describe, expect, it } from 'vitest';
import { CompletedTransfer, ResolveState } from '@app/types';
import {
  activityBadge,
  activityError,
  activityStatusBadge,
  canResolveCheck,
  canCopyFailedTransfer,
  effectiveTransferStatus,
  isDeleteActivity,
  matchesActivitySearch,
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
