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

/** The rows that match the search text and, when set, the status; `search` is any case. */
export function filterActivity(
  rows: readonly CompletedTransfer[],
  search: string,
  status: TransferStatus | null
): readonly CompletedTransfer[] {
  const term = search.toLowerCase().trim();
  if (!term && !status) return rows;
  return rows.filter(
    item =>
      (!status || effectiveTransferStatus(item) === status) && matchesActivitySearch(item, term)
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

/**
 * What a check difference asks of the user:
 * - `toDestination`: the file only exists on the source, copy it over.
 * - `toSource`: the file only exists on the destination, copy it back.
 * - `choose`: both sides hold the file but differ, so one side has to win.
 */
export type CheckResolution = 'toDestination' | 'toSource' | 'choose';

/** The direction a user picks for a file that differs on both sides. */
export type CheckDirection = Exclude<CheckResolution, 'choose'>;

export function checkResolution(item: CompletedTransfer): CheckResolution | null {
  if (!canResolveCheck(item)) return null;
  switch (item.status) {
    case TRANSFER_STATUS.MissingDestination:
      return 'toDestination';
    case TRANSFER_STATUS.MissingSource:
      return 'toSource';
    default:
      return 'choose';
  }
}

export interface CheckResolutionInfo {
  icon: string;
  cssClass: string;
  /** Says what happens to the file and in which direction. */
  directionKey: string;
  /** The short form of `directionKey`, for a table cell. */
  labelKey: string;
  /** Names the row action. */
  actionKey: string;
}

export const CHECK_RESOLUTION_INFO: Readonly<Record<CheckResolution, CheckResolutionInfo>> =
  Object.freeze({
    toDestination: {
      icon: 'right-arrow',
      cssClass: 'p-primary',
      directionKey: 'shared.transferActivity.direction.toDestination',
      labelKey: 'shared.transferActivity.direction.labelToDestination',
      actionKey: 'shared.transferActivity.actions.resolveToDst',
    },
    toSource: {
      icon: 'left-arrow',
      cssClass: 'p-accent',
      directionKey: 'shared.transferActivity.direction.toSource',
      labelKey: 'shared.transferActivity.direction.labelToSource',
      actionKey: 'shared.transferActivity.actions.resolveToSrc',
    },
    choose: {
      icon: 'right-left',
      cssClass: 'p-orange',
      directionKey: 'shared.transferActivity.direction.choose',
      labelKey: 'shared.transferActivity.direction.labelChoose',
      actionKey: 'shared.transferActivity.actions.resolveChoose',
    },
  });

/** Identifies a comparison result; the same file in another job or pair is another row. */
export function checkRowId(item: CompletedTransfer): string {
  return JSON.stringify([item.jobid, item.srcFs, item.dstFs, item.name]);
}

/** One side of a comparison: a file on a filesystem. */
export interface CompareSide {
  fs: string;
  path: string;
}

/** The two files a check difference compares: the same name under each root. */
export function compareSidesOf(item: Pick<CompletedTransfer, 'name' | 'srcFs' | 'dstFs'>): {
  src: CompareSide;
  dst: CompareSide;
} {
  return {
    src: { fs: item.srcFs ?? '', path: item.name },
    dst: { fs: item.dstFs ?? '', path: item.name },
  };
}

export interface ResolutionCounts {
  toDestination: number;
  toSource: number;
  choose: number;
}

/** How many of the items copy one way and how many need a decision. */
export function resolutionCounts(items: readonly CompletedTransfer[]): ResolutionCounts {
  const counts: ResolutionCounts = { toDestination: 0, toSource: 0, choose: 0 };
  for (const item of items) {
    const resolution = checkResolution(item);
    if (resolution) counts[resolution]++;
  }
  return counts;
}

/** What one side holds for a file, as reported by the remote. */
export interface FileVersion {
  /** Bytes, or -1 when the remote does not report a size. */
  size: number;
  /** ISO timestamp, or null when the remote has no modification times. */
  modTime: string | null;
}

export interface VersionComparison {
  /** The side with the later modification time, null when equal or unknown. */
  newer: ActivityTarget | null;
  /** The side with more bytes, null when equal or unknown. */
  larger: ActivityTarget | null;
}

export function compareVersions(
  src: FileVersion | null,
  dst: FileVersion | null
): VersionComparison {
  if (!src || !dst) return { newer: null, larger: null };
  const srcTime = src.modTime ? Date.parse(src.modTime) : NaN;
  const dstTime = dst.modTime ? Date.parse(dst.modTime) : NaN;
  const timesKnown = Number.isFinite(srcTime) && Number.isFinite(dstTime);
  const sizesKnown = src.size >= 0 && dst.size >= 0;
  return {
    newer: !timesKnown || srcTime === dstTime ? null : srcTime > dstTime ? 'src' : 'dst',
    larger: !sizesKnown || src.size === dst.size ? null : src.size > dst.size ? 'src' : 'dst',
  };
}

/** The path of a compared file as a user reads it: the side's root joined with the file name. */
export function displayPath(fs: string, name: string): string {
  if (!name) return fs;
  if (!fs || fs.endsWith(':') || fs.endsWith('/') || fs.endsWith('\\')) return `${fs}${name}`;
  return `${fs}/${name}`;
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

/** A file path as its folders and its file name. */
export function splitPath(path: string): { dir: string; base: string } {
  const index = path.lastIndexOf('/');
  return index < 0
    ? { dir: '', base: path }
    : { dir: path.slice(0, index + 1), base: path.slice(index + 1) };
}

/** A copy of `set` with `value` in it or out of it, for signals that hold sets. */
export function withMember<T>(set: ReadonlySet<T>, value: T, present: boolean): Set<T> {
  const next = new Set(set);
  if (present) next.add(value);
  else next.delete(value);
  return next;
}

const CSV_HEADER = [
  'name',
  'status',
  'source',
  'destination',
  'size',
  'bytes',
  'completed',
  'error',
];

function csvCell(value: string | number | undefined): string {
  const text = value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The rows of the activity list as CSV text, one line per file. */
export function activityCsv(rows: readonly CompletedTransfer[]): string {
  const lines = rows.map(row =>
    [row.name, row.status, row.srcFs, row.dstFs, row.size, row.bytes, row.completedAt, row.error]
      .map(csvCell)
      .join(',')
  );
  return [CSV_HEADER.join(','), ...lines].join('\n');
}
