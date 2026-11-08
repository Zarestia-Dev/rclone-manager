import { describe, it, expect } from 'vitest';
import {
  hasFileReport,
  JOB_REPORT_KEYS,
  jobReportOf,
  parseReportLine,
  FILE_REPORT_OPERATIONS,
  REPORT_PILLS,
  reportEntries,
  withFileReport,
  withReport,
} from './job-report.util';

describe('job-report.util', () => {
  it('lists every report key rclone accepts once', () => {
    expect([...JOB_REPORT_KEYS].sort()).toEqual(
      ['combined', 'destAfter', 'differ', 'error', 'match', 'missingOnDst', 'missingOnSrc'].sort()
    );
  });

  it('colours every report, and the sigils of the combined one the same way', () => {
    expect(Object.keys(REPORT_PILLS).sort()).toEqual([...JOB_REPORT_KEYS].sort());
    expect(parseReportLine('+ a', true).pill).toBe(REPORT_PILLS.missingOnDst);
    expect(parseReportLine('* a', true).pill).toBe(REPORT_PILLS.differ);
    expect(parseReportLine('! a', true).pill).toBe(REPORT_PILLS.error);
  });

  it('splits each sigil of a combined line from its path', () => {
    for (const sigil of ['+', '-', '*', '=', '!']) {
      const entry = parseReportLine(`${sigil} dir/a.txt`, true);
      expect(entry.sigil).toBe(sigil);
      expect(entry.path).toBe('dir/a.txt');
      expect(entry.labelKey).toContain('shared.transferActivity.report.sigils.');
      expect(entry.pill).toMatch(/^p-/);
      expect(entry.icon).toBeTruthy();
    }
  });

  it('keeps paths with spaces, sigil characters and non-ASCII names intact', () => {
    expect(parseReportLine('+ - minus start.txt', true).path).toBe('- minus start.txt');
    expect(parseReportLine('= ü ö/ğ.txt', true).path).toBe('ü ö/ğ.txt');
  });

  it('treats a combined line without a known sigil as a plain path', () => {
    for (const line of ['? odd.txt', 'plain.txt', '+x', '+ ', '']) {
      expect(parseReportLine(line, true)).toEqual({ sigil: null, path: line });
    }
  });

  it('never reads a sigil in the plain file lists', () => {
    expect(parseReportLine('+ looks like a sigil.txt', false)).toEqual({
      sigil: null,
      path: '+ looks like a sigil.txt',
    });
  });

  it('maps a whole report', () => {
    expect(reportEntries('combined', ['+ a', '! b']).map(e => e.sigil)).toEqual(['+', '!']);
    expect(reportEntries('match', ['a']).map(e => e.path)).toEqual(['a']);
    expect(reportEntries('error', [])).toEqual([]);
  });

  it('offers a job its reports only when it kept some', () => {
    expect(jobReportOf({ jobid: 3, report_counts: { combined: 2 } })).toEqual({
      jobId: 3,
      counts: { combined: 2 },
    });
    expect(jobReportOf({ jobid: 3 })).toBeUndefined();
    expect(jobReportOf(null)).toBeUndefined();
  });

  it('carries the two paths of a bisync job, whether the source is a list or a string', () => {
    const counts = { conflicts: 2 };
    expect(
      jobReportOf({
        jobid: 8,
        report_counts: counts,
        source: ['gdrive:Notes'],
        destination: '/home/me/Notes',
        dry_run: false,
      })
    ).toEqual({
      jobId: 8,
      counts,
      path1: 'gdrive:Notes',
      path2: '/home/me/Notes',
      dryRun: false,
    });
    expect(
      jobReportOf({ jobid: 8, report_counts: counts, source: 'gdrive:Notes', destination: '' })
    ).toMatchObject({ path1: 'gdrive:Notes', path2: undefined });
  });

  it('tells a report that lists files from one that only has conflicts', () => {
    expect(hasFileReport({ combined: 3 })).toBe(true);
    expect(hasFileReport({ match: 0 })).toBe(true);
    expect(hasFileReport({ conflicts: 2 })).toBe(false);
    expect(hasFileReport({})).toBe(false);
    expect(hasFileReport(undefined)).toBe(false);
  });

  describe('asking for file reports', () => {
    it('turns on the combined report and keeps every other option', () => {
      expect(withFileReport(undefined, true)).toEqual({ combined: true });
      expect(withFileReport({ differ: true, createEmptySrcDirs: true }, true)).toEqual({
        differ: true,
        createEmptySrcDirs: true,
        combined: true,
      });
    });

    it('turns every report off and keeps every other option', () => {
      const all = Object.fromEntries(JOB_REPORT_KEYS.map(key => [key, true]));
      expect(withFileReport({ ...all, createEmptySrcDirs: true }, false)).toEqual({
        createEmptySrcDirs: true,
      });
      expect(withFileReport(undefined, false)).toEqual({});
    });

    it('turns a single report on or off and leaves the rest alone', () => {
      expect(withReport({ combined: true, resync: true }, 'differ', true)).toEqual({
        combined: true,
        resync: true,
        differ: true,
      });
      expect(withReport({ combined: true, differ: true }, 'differ', false)).toEqual({
        combined: true,
      });
      expect(withReport(undefined, 'match', false)).toEqual({});
    });

    it('does not change the options it was given', () => {
      const given = { combined: true, resync: true };
      withFileReport(given, false);
      expect(given).toEqual({ combined: true, resync: true });
    });

    it('applies to the operations that keep reports', () => {
      expect([...FILE_REPORT_OPERATIONS].sort()).toEqual(['copy', 'move', 'sync']);
    });
  });
});
