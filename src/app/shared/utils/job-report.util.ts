import { JobInfo, JobReportKey, TransferActivityPanelConfig } from '@app/types';

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

/** What a leading sigil of a `combined` report line means (see rclone's `operations.Sigil`). */
const SIGIL_PILLS: Readonly<Record<string, { labelKey: string; pill: string }>> = {
  '+': { labelKey: 'shared.transferActivity.report.sigils.missingOnDst', pill: 'p-primary' },
  '-': { labelKey: 'shared.transferActivity.report.sigils.missingOnSrc', pill: 'p-orange' },
  '*': { labelKey: 'shared.transferActivity.report.sigils.differ', pill: 'p-accent' },
  '=': { labelKey: 'shared.transferActivity.report.sigils.match', pill: 'p-dim' },
  '!': { labelKey: 'shared.transferActivity.report.sigils.error', pill: 'p-warn' },
};

export interface JobReportEntry {
  /** The sigil of a `combined` line, `null` for the plain file lists. */
  sigil: string | null;
  path: string;
  labelKey?: string;
  pill?: string;
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

/** What the activity panel needs to offer a job's reports, `undefined` when it kept none. */
export function jobReportOf(
  job: Pick<JobInfo, 'jobid' | 'report_counts'> | null | undefined
): TransferActivityPanelConfig['report'] {
  return job?.report_counts ? { jobId: job.jobid, counts: job.report_counts } : undefined;
}
