import { describe, it, expect } from 'vitest';
import { JOB_REPORT_KEYS, jobReportOf, parseReportLine, reportEntries } from './job-report.util';

describe('job-report.util', () => {
  it('lists every report key rclone accepts once', () => {
    expect([...JOB_REPORT_KEYS].sort()).toEqual(
      ['combined', 'destAfter', 'differ', 'error', 'match', 'missingOnDst', 'missingOnSrc'].sort()
    );
  });

  it('splits each sigil of a combined line from its path', () => {
    for (const sigil of ['+', '-', '*', '=', '!']) {
      const entry = parseReportLine(`${sigil} dir/a.txt`, true);
      expect(entry.sigil).toBe(sigil);
      expect(entry.path).toBe('dir/a.txt');
      expect(entry.labelKey).toContain('shared.transferActivity.report.sigils.');
      expect(entry.pill).toMatch(/^p-/);
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
});
