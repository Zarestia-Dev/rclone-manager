import {
  CompletedTransfer,
  CHECK_OPERATIONS,
  DELETE_OPERATIONS,
  JOB_STATUS,
  RCLONE_ACTIVITY,
  TRANSFER_STATUS,
  TRANSFER_OPERATIONS,
  TransferStatus,
  RcloneActivity,
  JobActionType,
} from '@app/types';

export type ActivityTarget = 'src' | 'dst';
export type ActivityActionItem = Pick<CompletedTransfer, 'name'> &
  Partial<Pick<CompletedTransfer, 'srcFs' | 'dstFs' | 'what' | 'status' | 'resolveState'>>;

export interface ActivityRow extends CompletedTransfer {
  uniqueId: string;
}

export interface ActivityBadge {
  cssClass: string;
  icon: string;
  text: string;
}

const STATUS_BADGES: Readonly<Record<TransferStatus, ActivityBadge>> = Object.freeze({
  [TRANSFER_STATUS.Completed]: {
    cssClass: 'p-primary',
    icon: 'check-circle',
    text: 'shared.transferActivity.status.completed',
  },
  [TRANSFER_STATUS.Checked]: {
    cssClass: 'p-accent',
    icon: 'check-circle',
    text: 'shared.transferActivity.status.checked',
  },
  [TRANSFER_STATUS.Failed]: {
    cssClass: 'p-warn',
    icon: 'circle-exclamation',
    text: 'shared.transferActivity.status.failed',
  },
  [TRANSFER_STATUS.Partial]: {
    cssClass: 'p-orange',
    icon: 'circle-exclamation',
    text: 'shared.transferActivity.status.partial',
  },
  [TRANSFER_STATUS.MissingDestination]: {
    cssClass: 'p-warn',
    icon: 'circle-exclamation',
    text: 'shared.transferActivity.status.missingDst',
  },
  [TRANSFER_STATUS.MissingSource]: {
    cssClass: 'p-warn',
    icon: 'circle-exclamation',
    text: 'shared.transferActivity.status.missingSrc',
  },
});
const DIFFERENCE_BADGE: ActivityBadge = {
  cssClass: 'p-orange',
  icon: 'circle-exclamation',
  text: 'shared.transferActivity.status.differ',
};
const DELETE_BADGE: ActivityBadge = { cssClass: 'p-primary', icon: 'trash', text: 'common.delete' };

export function activityBadge(item: CompletedTransfer, jobType: JobActionType): ActivityBadge {
  const status = effectiveTransferStatus(item);
  if (status === TRANSFER_STATUS.Completed && isDeleteActivity(item, jobType)) return DELETE_BADGE;
  return activityStatusBadge(status, jobType);
}

export function activityStatusBadge(status: TransferStatus, jobType: JobActionType): ActivityBadge {
  if (status === TRANSFER_STATUS.Partial && CHECK_OPERATIONS.has(jobType)) return DIFFERENCE_BADGE;
  return STATUS_BADGES[status] || STATUS_BADGES[TRANSFER_STATUS.Failed];
}

export function matchesActivitySearch(
  item: {
    name: string;
    srcFs?: string;
    dstFs?: string;
    error?: string;
    what?: string;
    resolveState?: { error?: string };
  },
  search: string
): boolean {
  return (
    !search ||
    item.name.toLowerCase().includes(search) ||
    !!item.srcFs?.toLowerCase().includes(search) ||
    !!item.dstFs?.toLowerCase().includes(search) ||
    !!item.error?.toLowerCase().includes(search) ||
    !!item.what?.toLowerCase().includes(search) ||
    !!item.resolveState?.error?.toLowerCase().includes(search)
  );
}

export function effectiveTransferStatus(item: CompletedTransfer): TransferStatus {
  if (item.resolveState?.status === JOB_STATUS.Completed) return TRANSFER_STATUS.Completed;
  if (item.resolveState?.status === JOB_STATUS.Failed) return TRANSFER_STATUS.Failed;
  return item.status;
}

export function activityError(item: CompletedTransfer): string {
  if (item.resolveState?.status === JOB_STATUS.Completed) return '';
  return item.resolveState?.error || item.error;
}

export function canResolveCheck(item: CompletedTransfer): boolean {
  return (
    !!item.srcFs &&
    !!item.dstFs &&
    item.resolveState?.status !== JOB_STATUS.Completed &&
    (item.status === TRANSFER_STATUS.MissingDestination ||
      item.status === TRANSFER_STATUS.MissingSource ||
      item.status === TRANSFER_STATUS.Partial)
  );
}

/** Group names are opaque. Only explicit activity or the job's type identifies a deletion. */
export function isDeleteActivity(item: { what?: RcloneActivity }, jobType: JobActionType): boolean {
  return item.what ? item.what === RCLONE_ACTIVITY.Deleting : DELETE_OPERATIONS.has(jobType);
}

export function canCopyFailedTransfer(item: CompletedTransfer, jobType: JobActionType): boolean {
  return (
    TRANSFER_OPERATIONS.has(jobType) &&
    item.status === TRANSFER_STATUS.Failed &&
    item.resolveState?.status !== JOB_STATUS.Completed &&
    !!item.srcFs &&
    !!item.dstFs &&
    (!item.what || item.what === RCLONE_ACTIVITY.Transferring)
  );
}
