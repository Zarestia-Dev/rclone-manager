import {
  CHECK_OPERATIONS,
  CompletedTransfer,
  DELETE_OPERATIONS,
  GlobalStats,
  JobActionType,
  TRANSFER_STATUS,
} from '@app/types';

export type MonitorKpiFormat = 'percent' | 'rate' | 'duration' | 'count' | 'fraction' | 'bytes';

/** A secondary figure under a KPI value; `key` labels it when it needs a label. */
export interface MonitorKpiSub {
  key?: string;
  value: number;
  format: MonitorKpiFormat;
}

export interface MonitorKpi {
  /** Stable across updates so the view can track it. */
  key: string;
  labelKey: string;
  format: MonitorKpiFormat;
  value: number;
  /** The denominator of a `fraction`. */
  total?: number;
  /** Fills a bar under the value, 0 to 100. */
  progress?: number;
  /** Draws the recent speed samples under the value. */
  sparkline?: boolean;
  subs?: MonitorKpiSub[];
  /** Free text under the value, e.g. rclone's last error. */
  subText?: string;
  tone?: 'warn' | 'orange';
  /** The figure that matters most; leads on narrow screens. */
  hero?: boolean;
}

export interface MonitorKpiInput {
  jobType: JobActionType;
  stats: GlobalStats;
  completed: readonly CompletedTransfer[];
  running: boolean;
  /** Recent speed samples in bytes per second, oldest first. */
  speedHistory: readonly number[];
}

function percent(done: number, total: number): number {
  return total > 0 ? Math.min(100, (done / total) * 100) : 0;
}

function countStatus(completed: readonly CompletedTransfer[], ...statuses: string[]): number {
  return completed.filter(item => statuses.includes(item.status)).length;
}

/** How long the job ran: rclone's elapsed time, falling back to the time spent transferring. */
function ranFor(stats: GlobalStats): number {
  return stats.elapsedTime > 0 ? stats.elapsedTime : stats.transferTime;
}

function timeKpi(input: MonitorKpiInput): MonitorKpi {
  return input.running
    ? { key: 'eta', labelKey: 'shared.monitor.kpi.eta', format: 'duration', value: input.stats.eta }
    : {
        key: 'took',
        labelKey: 'shared.monitor.kpi.took',
        format: 'duration',
        value: ranFor(input.stats),
      };
}

function errorsKpi(stats: GlobalStats): MonitorKpi {
  return {
    key: 'errors',
    labelKey: 'shared.monitor.kpi.errors',
    format: 'count',
    value: stats.errors,
    tone: stats.errors > 0 ? 'warn' : undefined,
    subText: stats.errors > 0 && stats.lastError ? stats.lastError : undefined,
  };
}

function transferKpis(input: MonitorKpiInput): MonitorKpi[] {
  const { stats, running, speedHistory } = input;
  const average = stats.transferTime > 0 ? stats.bytes / stats.transferTime : 0;
  const peak = speedHistory.length > 1 ? Math.max(...speedHistory) : 0;
  const speedSubs: MonitorKpiSub[] = [];
  if (running && average > 0) {
    speedSubs.push({ key: 'shared.monitor.kpi.avg', value: average, format: 'rate' });
  }
  if (peak > 0) speedSubs.push({ key: 'shared.monitor.kpi.peak', value: peak, format: 'rate' });

  return [
    {
      key: 'progress',
      labelKey: 'shared.monitor.kpi.progress',
      format: 'percent',
      value: percent(stats.bytes, stats.totalBytes),
      progress: percent(stats.bytes, stats.totalBytes),
      subs: [
        { value: stats.bytes, format: 'bytes' },
        { key: 'shared.monitor.kpi.total', value: stats.totalBytes, format: 'bytes' },
      ],
      hero: true,
    },
    {
      key: 'speed',
      labelKey: running ? 'shared.monitor.kpi.speed' : 'shared.monitor.kpi.avgSpeed',
      format: 'rate',
      value: running ? stats.speed : average,
      sparkline: running && speedHistory.length > 1,
      subs: speedSubs,
    },
    timeKpi(input),
    {
      key: 'files',
      labelKey: 'shared.monitor.kpi.files',
      format: 'fraction',
      value: stats.transfers,
      total: stats.totalTransfers,
      subs:
        stats.totalTransfers > stats.transfers
          ? [
              {
                key: 'shared.monitor.kpi.left',
                value: stats.totalTransfers - stats.transfers,
                format: 'count',
              },
            ]
          : [],
    },
    {
      key: 'checks',
      labelKey: 'shared.monitor.kpi.checks',
      format: 'fraction',
      value: stats.checks,
      total: stats.totalChecks,
    },
    errorsKpi(stats),
  ];
}

function differenceSubs(completed: readonly CompletedTransfer[]): MonitorKpiSub[] {
  const subs: MonitorKpiSub[] = [
    {
      key: 'shared.monitor.kpi.onlyOnSource',
      value: countStatus(completed, TRANSFER_STATUS.MissingDestination),
      format: 'count',
    },
    {
      key: 'shared.monitor.kpi.onlyOnDestination',
      value: countStatus(completed, TRANSFER_STATUS.MissingSource),
      format: 'count',
    },
    {
      key: 'shared.monitor.kpi.differ',
      value: countStatus(completed, TRANSFER_STATUS.Partial),
      format: 'count',
    },
  ];
  return subs.filter(sub => sub.value > 0);
}

function checkKpis(input: MonitorKpiInput): MonitorKpi[] {
  const { stats, completed, running } = input;
  const differences = countStatus(
    completed,
    TRANSFER_STATUS.Partial,
    TRANSFER_STATUS.MissingDestination,
    TRANSFER_STATUS.MissingSource
  );
  const failed = countStatus(completed, TRANSFER_STATUS.Failed);
  // rclone counts every file it compared. Its rows list matches only when the profile asks for
  // them, so without any the matches are what was compared minus what did not match.
  const compared = stats.checks > 0 ? stats.checks : completed.length;
  const listedMatches = countStatus(completed, TRANSFER_STATUS.Checked);
  const matched = listedMatches > 0 ? listedMatches : Math.max(0, compared - differences - failed);
  return [
    running
      ? {
          key: 'compared',
          labelKey: 'shared.monitor.kpi.checked',
          format: 'fraction',
          value: stats.checks,
          total: stats.totalChecks,
          progress: percent(stats.checks, stats.totalChecks),
          hero: true,
        }
      : {
          key: 'compared',
          labelKey: 'shared.monitor.kpi.compared',
          format: 'count',
          value: compared,
        },
    {
      key: 'matched',
      labelKey: 'shared.monitor.kpi.matched',
      format: 'count',
      value: matched,
    },
    {
      key: 'differences',
      labelKey: 'shared.monitor.kpi.differences',
      format: 'count',
      value: differences,
      tone: differences > 0 ? 'orange' : undefined,
      hero: !running,
      subs: differenceSubs(completed),
    },
    {
      key: 'unreadable',
      labelKey: 'shared.monitor.kpi.unreadable',
      format: 'count',
      value: failed,
      tone: failed > 0 ? 'warn' : undefined,
    },
    timeKpi(input),
  ];
}

function deleteKpis(input: MonitorKpiInput): MonitorKpi[] {
  const { stats } = input;
  return [
    {
      key: 'deleted',
      labelKey: 'shared.monitor.kpi.deleted',
      format: 'count',
      value: stats.deletes + stats.deletedDirs,
      hero: true,
    },
    {
      key: 'checks',
      labelKey: 'shared.monitor.kpi.checks',
      format: 'fraction',
      value: stats.checks,
      total: stats.totalChecks,
    },
    timeKpi(input),
    errorsKpi(stats),
  ];
}

/** The figures that matter for this kind of job, built from what rclone reported. */
export function monitorKpis(input: MonitorKpiInput): MonitorKpi[] {
  if (CHECK_OPERATIONS.has(input.jobType)) return checkKpis(input);
  if (DELETE_OPERATIONS.has(input.jobType)) return deleteKpis(input);
  return transferKpis(input);
}

/** Speed samples kept per job; at one sample per stats update this spans a couple of minutes. */
export const SPEED_HISTORY_LIMIT = 60;

/** Appends a sample and drops the oldest beyond the limit. Unusable samples are ignored. */
export function appendSpeedSample(
  history: readonly number[],
  speed: number,
  limit = SPEED_HISTORY_LIMIT
): number[] {
  if (!Number.isFinite(speed) || speed < 0) return [...history];
  const next = [...history, speed];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export interface SparklineGeometry {
  line: string;
  area: string;
  last: { x: number; y: number } | null;
}

/** SVG path data for a series scaled into `width` by `height`, with `pad` kept clear at the edges. */
export function sparkline(
  values: readonly number[],
  width: number,
  height: number,
  pad = 2
): SparklineGeometry {
  if (values.length < 2) return { line: '', area: '', last: null };
  const peak = Math.max(...values) * 1.1 || 1;
  const points = values.map((value, index) => ({
    x: (index / (values.length - 1)) * width,
    y: height - pad - (Math.max(0, value) / peak) * (height - pad * 2),
  }));
  const line = points
    .map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(' ');
  return { line, area: `${line} L${width} ${height} L0 ${height} Z`, last: points.at(-1) ?? null };
}
