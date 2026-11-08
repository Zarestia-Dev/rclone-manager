import { JobInfo, JobReportCounts, JobReportKey, TransferActivityPanelConfig } from '@app/types';

/** The reports in the order a view lists them. */
export const JOB_REPORT_KEYS: readonly JobReportKey[] = [
  'combined',
  'missingOnDst',
  'differ',
  'missingOnSrc',
  'match',
  'error',
  'destAfter',
];

/** The colour each report is shown in; its sigil pills in `combined` use the same one. */
export const REPORT_PILLS: Readonly<Record<JobReportKey, string>> = {
  combined: 'p-dim',
  missingOnDst: 'p-primary',
  differ: 'p-accent',
  missingOnSrc: 'p-orange',
  match: 'p-dim',
  error: 'p-warn',
  destAfter: 'p-dim',
};

/** The operations whose jobs keep file reports (the others return nothing worth keeping). */
export const FILE_REPORT_OPERATIONS: ReadonlySet<string> = new Set(['sync', 'copy', 'move']);

/**
 * The options with file reports on or off. On asks for the combined report, which lists every
 * file with its result, and keeps any other report already on; off clears every report.
 */
export function withFileReport(
  rclone: Readonly<Record<string, unknown>> | undefined,
  on: boolean
): Record<string, unknown> {
  if (on) return { ...rclone, combined: true };
  const options = { ...rclone };
  for (const key of JOB_REPORT_KEYS) delete options[key];
  return options;
}

/** The options with one report on or off, every other option as it was. */
export function withReport(
  rclone: Readonly<Record<string, unknown>> | undefined,
  key: JobReportKey,
  on: boolean
): Record<string, unknown> {
  const options = { ...rclone };
  if (on) options[key] = true;
  else delete options[key];
  return options;
}

/** What a leading sigil of a `combined` report line means (see rclone's `operations.Sigil`). */
const SIGIL_PILLS: Readonly<Record<string, { labelKey: string; pill: string; icon: string }>> = {
  '+': {
    labelKey: 'shared.transferActivity.report.sigils.missingOnDst',
    pill: REPORT_PILLS.missingOnDst,
    icon: 'plus',
  },
  '-': {
    labelKey: 'shared.transferActivity.report.sigils.missingOnSrc',
    pill: REPORT_PILLS.missingOnSrc,
    icon: 'circle-exclamation',
  },
  '*': {
    labelKey: 'shared.transferActivity.report.sigils.differ',
    pill: REPORT_PILLS.differ,
    icon: 'pen',
  },
  '=': {
    labelKey: 'shared.transferActivity.report.sigils.match',
    pill: REPORT_PILLS.match,
    icon: 'check-circle',
  },
  '!': {
    labelKey: 'shared.transferActivity.report.sigils.error',
    pill: REPORT_PILLS.error,
    icon: 'circle-exclamation',
  },
};

export interface JobReportEntry {
  /** The sigil of a `combined` line, `null` for the plain file lists. */
  sigil: string | null;
  path: string;
  labelKey?: string;
  pill?: string;
  icon?: string;
}

/** Splits a `combined` line (`+ path`) into its sigil and path; other lines are plain paths. */
export function parseReportLine(line: string, combined: boolean): JobReportEntry {
  const sigil = combined && line.length > 2 && line[1] === ' ' ? line[0] : null;
  const known = sigil ? SIGIL_PILLS[sigil] : undefined;
  if (!sigil || !known) return { sigil: null, path: line };
  return { sigil, path: line.slice(2), ...known };
}

/** The entries of one report of a finished job. */
export function reportEntries(key: JobReportKey, lines: readonly string[]): JobReportEntry[] {
  const combined = key === 'combined';
  return lines.map(line => parseReportLine(line, combined));
}

/** Whether a job kept a report that lists files (as opposed to bisync conflicts). */
export function hasFileReport(counts: JobReportCounts | undefined): boolean {
  return !!counts && JOB_REPORT_KEYS.some(key => counts[key] !== undefined);
}

/** What the activity panel needs to offer a job's reports, `undefined` when it kept none. */
export function jobReportOf(
  job:
    | (Pick<JobInfo, 'jobid' | 'report_counts'> &
        Partial<Pick<JobInfo, 'source' | 'destination' | 'dry_run'>>)
    | null
    | undefined
): TransferActivityPanelConfig['report'] {
  if (!job?.report_counts) return undefined;
  return {
    jobId: job.jobid,
    counts: job.report_counts,
    path1: Array.isArray(job.source) ? job.source[0] : job.source || undefined,
    path2: job.destination || undefined,
    dryRun: job.dry_run,
  };
}
