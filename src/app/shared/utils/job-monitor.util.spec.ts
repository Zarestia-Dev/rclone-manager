import { describe, expect, it } from 'vitest';
import { CompletedTransfer, DEFAULT_JOB_STATS, GlobalStats } from '@app/types';
import {
  appendSpeedSample,
  monitorKpis,
  MonitorKpi,
  sparkline,
  SPEED_HISTORY_LIMIT,
} from './job-monitor.util';

const stats = (extra: Partial<GlobalStats> = {}): GlobalStats => ({
  ...DEFAULT_JOB_STATS,
  ...extra,
});
const row = (
  name: string,
  status: CompletedTransfer['status'],
  extra: Partial<CompletedTransfer> = {}
): CompletedTransfer => ({
  jobid: 1,
  name,
  size: 10,
  bytes: 10,
  checked: false,
  error: '',
  status,
  ...extra,
});
const byKey = (kpis: MonitorKpi[], key: string): MonitorKpi | undefined =>
  kpis.find(kpi => kpi.key === key);

describe('monitorKpis', () => {
  it('leads a running transfer with progress and shows the live speed and the ETA', () => {
    const kpis = monitorKpis({
      jobType: 'sync',
      stats: stats({
        bytes: 250,
        totalBytes: 1000,
        speed: 50,
        transferTime: 5,
        eta: 15,
        transfers: 3,
        totalTransfers: 10,
        checks: 4,
        totalChecks: 9,
        errors: 1,
        lastError: 'rate limit',
      }),
      completed: [],
      running: true,
      speedHistory: [10, 80, 40],
    });
    expect(kpis.map(kpi => kpi.key)).toEqual([
      'progress',
      'speed',
      'eta',
      'files',
      'checks',
      'errors',
    ]);
    expect(byKey(kpis, 'progress')).toMatchObject({ value: 25, progress: 25, hero: true });
    expect(byKey(kpis, 'speed')).toMatchObject({ value: 50, sparkline: true });
    expect(byKey(kpis, 'speed')?.subs).toEqual([
      { key: 'shared.monitor.kpi.avg', value: 50, format: 'rate' },
      { key: 'shared.monitor.kpi.peak', value: 80, format: 'rate' },
    ]);
    expect(byKey(kpis, 'eta')).toMatchObject({ value: 15, format: 'duration' });
    expect(byKey(kpis, 'files')).toMatchObject({ value: 3, total: 10 });
    expect(byKey(kpis, 'files')?.subs?.[0]).toMatchObject({ value: 7 });
    expect(byKey(kpis, 'errors')).toMatchObject({ value: 1, tone: 'warn', subText: 'rate limit' });
  });

  it('reports the average speed and the time taken once a transfer has finished', () => {
    const kpis = monitorKpis({
      jobType: 'copy',
      stats: stats({
        bytes: 1000,
        totalBytes: 1000,
        speed: 0,
        transferTime: 20,
        elapsedTime: 25,
        transfers: 4,
        totalTransfers: 4,
      }),
      completed: [],
      running: false,
      speedHistory: [],
    });
    expect(byKey(kpis, 'speed')).toMatchObject({
      labelKey: 'shared.monitor.kpi.avgSpeed',
      value: 50,
      sparkline: false,
    });
    expect(byKey(kpis, 'took')).toMatchObject({ value: 25 });
    expect(byKey(kpis, 'eta')).toBeUndefined();
    expect(byKey(kpis, 'files')?.subs).toEqual([]);
    expect(byKey(kpis, 'errors')).toMatchObject({ value: 0, tone: undefined, subText: undefined });
  });

  it('shows no progress for a job that has no known total', () => {
    const kpis = monitorKpis({
      jobType: 'sync',
      stats: stats({ bytes: 100, totalBytes: 0 }),
      completed: [],
      running: true,
      speedHistory: [],
    });
    expect(byKey(kpis, 'progress')).toMatchObject({ value: 0, progress: 0 });
  });

  it('counts a check by what it found, from the comparison rows', () => {
    const completed = [
      row('a', 'checked'),
      row('b', 'checked'),
      row('c', 'missing_dst'),
      row('d', 'missing_src'),
      row('e', 'partial'),
      row('f', 'partial'),
      row('g', 'failed'),
    ];
    const kpis = monitorKpis({
      jobType: 'check',
      stats: stats({ checks: 7, totalChecks: 7, elapsedTime: 9 }),
      completed,
      running: false,
      speedHistory: [],
    });
    expect(byKey(kpis, 'compared')).toMatchObject({ format: 'count', value: 7 });
    expect(byKey(kpis, 'matched')?.value).toBe(2); // the two rows listed as matches
    expect(byKey(kpis, 'differences')).toMatchObject({ value: 4, tone: 'orange', hero: true });
    expect(byKey(kpis, 'differences')?.subs?.map(sub => [sub.key, sub.value])).toEqual([
      ['shared.monitor.kpi.onlyOnSource', 1],
      ['shared.monitor.kpi.onlyOnDestination', 1],
      ['shared.monitor.kpi.differ', 2],
    ]);
    expect(byKey(kpis, 'unreadable')).toMatchObject({ value: 1, tone: 'warn' });
    expect(byKey(kpis, 'took')?.value).toBe(9);
  });

  it('counts what a check compared from rclone and derives the matches the rows do not list', () => {
    // rclone compared 8 files and reported 4 of them; the other 4 matched and are not listed
    const kpis = monitorKpis({
      jobType: 'check',
      stats: stats({ checks: 8, totalChecks: 8, errors: 4 }),
      completed: [
        row('a', 'missing_dst'),
        row('b', 'missing_src'),
        row('c', 'partial'),
        row('d', 'partial'),
      ],
      running: false,
      speedHistory: [],
    });
    expect(byKey(kpis, 'compared')?.value).toBe(8);
    expect(byKey(kpis, 'matched')?.value).toBe(4);
    expect(byKey(kpis, 'differences')?.value).toBe(4);
    const noRows = monitorKpis({
      jobType: 'check',
      stats: stats({ checks: 2, totalChecks: 2 }),
      completed: [row('a', 'partial'), row('b', 'failed'), row('c', 'failed')],
      running: false,
      speedHistory: [],
    });
    expect(byKey(noRows, 'matched')?.value).toBe(0); // never negative
  });

  it('tracks a running check by files checked so far and has no tone for a clean result', () => {
    const running = monitorKpis({
      jobType: 'cryptcheck',
      stats: stats({ checks: 30, totalChecks: 120 }),
      completed: [],
      running: true,
      speedHistory: [],
    });
    expect(byKey(running, 'compared')).toMatchObject({
      format: 'fraction',
      progress: 25,
      hero: true,
    });
    expect(byKey(running, 'differences')).toMatchObject({ value: 0, tone: undefined, hero: false });
    const clean = monitorKpis({
      jobType: 'check',
      stats: stats({ checks: 2, totalChecks: 2 }),
      completed: [row('a', 'checked'), row('b', 'checked')],
      running: false,
      speedHistory: [],
    });
    expect(byKey(clean, 'differences')).toMatchObject({ value: 0, tone: undefined, subs: [] });
  });

  it('counts a deletion by the files and directories removed', () => {
    const kpis = monitorKpis({
      jobType: 'delete',
      stats: stats({ deletes: 8, deletedDirs: 2, errors: 0, elapsedTime: 3 }),
      completed: [],
      running: false,
      speedHistory: [],
    });
    expect(kpis.map(kpi => kpi.key)).toEqual(['deleted', 'checks', 'took', 'errors']);
    expect(byKey(kpis, 'deleted')?.value).toBe(10);
  });
});

describe('appendSpeedSample', () => {
  it('keeps the newest samples within the limit', () => {
    let history: number[] = [];
    for (let i = 1; i <= SPEED_HISTORY_LIMIT + 5; i++) history = appendSpeedSample(history, i);
    expect(history).toHaveLength(SPEED_HISTORY_LIMIT);
    expect(history[0]).toBe(6);
    expect(history.at(-1)).toBe(SPEED_HISTORY_LIMIT + 5);
    expect(appendSpeedSample([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
  });

  it('ignores samples that are not a speed and never changes its input', () => {
    const history = [5];
    expect(appendSpeedSample(history, Number.NaN)).toEqual([5]);
    expect(appendSpeedSample(history, -1)).toEqual([5]);
    expect(appendSpeedSample(history, Infinity)).toEqual([5]);
    expect(appendSpeedSample(history, 0)).toEqual([5, 0]);
    expect(history).toEqual([5]);
  });
});

describe('sparkline', () => {
  it('draws nothing for fewer than two samples', () => {
    expect(sparkline([], 100, 20)).toEqual({ line: '', area: '', last: null });
    expect(sparkline([5], 100, 20).line).toBe('');
  });

  it('spans the full width and keeps every point inside the box', () => {
    const geometry = sparkline([0, 50, 100], 100, 20, 2);
    expect(geometry.line.startsWith('M0.0 ')).toBe(true);
    expect(geometry.last?.x).toBe(100);
    const ys = [...geometry.line.matchAll(/ (\d+\.\d)/g)].map(match => Number(match[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...ys)).toBeLessThanOrEqual(18);
    expect(geometry.area.endsWith('L100 20 L0 20 Z')).toBe(true);
  });

  it('copes with a flat series of zeros', () => {
    const geometry = sparkline([0, 0, 0], 60, 10);
    expect(geometry.line).not.toContain('NaN');
    expect(geometry.last).toEqual({ x: 60, y: 8 });
  });
});
