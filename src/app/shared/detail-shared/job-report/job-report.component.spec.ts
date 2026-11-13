import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { JobReportCounts } from '@app/types';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { JobReportComponent, REPORT_PAGE_SIZE } from './job-report.component';

describe('JobReportComponent', () => {
  let fixture: ComponentFixture<JobReportComponent>;
  let getJobReport: ReturnType<typeof vi.fn>;

  const report = {
    combined: ['+ new.txt', '- old.txt', '= same.txt'],
    missingOnDst: ['new.txt'],
    error: [],
  };

  async function show(
    counts: JobReportCounts,
    loaded: unknown = report,
    jobId = 42
  ): Promise<JobReportComponent> {
    getJobReport.mockResolvedValue(loaded);
    fixture = TestBed.createComponent(JobReportComponent);
    fixture.componentRef.setInput('jobId', jobId);
    fixture.componentRef.setInput('counts', counts);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  beforeEach(() => {
    getJobReport = vi.fn().mockResolvedValue(null);
    TestBed.configureTestingModule({
      imports: [JobReportComponent],
      providers: [
        provideTranslateService(),
        { provide: JobManagementService, useValue: { getJobReport } },
        { provide: IconService, useValue: {} },
      ],
    });
  });

  it('lists the reports in order and opens the first one that has files', async () => {
    const component = await show({ error: 0, missingOnDst: 1, combined: 3 });
    expect(component.tabs()).toEqual([
      { key: 'combined', count: 3 },
      { key: 'missingOnDst', count: 1 },
      { key: 'error', count: 0 },
    ]);
    expect(component.activeReport()).toBe('combined');
    expect(getJobReport).toHaveBeenCalledWith(42);
    expect(component.rows().map(row => [row.sigil, row.path])).toEqual([
      ['+', 'new.txt'],
      ['-', 'old.txt'],
      ['=', 'same.txt'],
    ]);
    expect(fixture.nativeElement.querySelectorAll('.card-row-item')).toHaveLength(3);
    // Each file's result is a labelled pill, not the bare sigil.
    expect(fixture.nativeElement.querySelectorAll('.card-row-item [appPill]')).toHaveLength(3);
    expect(fixture.nativeElement.querySelector('.file-dir')).not.toBeNull();
  });

  it('switches reports and shows plain paths without sigils', async () => {
    const component = await show({ combined: 3, missingOnDst: 1, error: 0 });
    component.select('missingOnDst');
    expect(component.rows()).toEqual([{ sigil: null, path: 'new.txt' }]);
    component.select('error');
    fixture.detectChanges();
    expect(component.rows()).toEqual([]);
    expect(fixture.nativeElement.querySelector('.empty-state')).not.toBeNull();
  });

  it('gives a file of a single-result report no result pill', async () => {
    const component = await show({ combined: 3, missingOnDst: 1 });
    component.select('missingOnDst');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.card-row-item')).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('.card-row-item [appPill]')).toBeNull();
  });

  it('opens the first report when none lists a file', async () => {
    const component = await show({ combined: 0, match: 0 }, { combined: [], match: [] });
    expect(component.activeReport()).toBe('combined');
  });

  it('shows a large report page by page', async () => {
    const files = Array.from({ length: 450 }, (_, i) => `f${i}.txt`);
    const component = await show({ match: 450 }, { match: files });
    expect(component.rows()).toHaveLength(REPORT_PAGE_SIZE);
    expect(component.hiddenCount()).toBe(250);
    component.showMore();
    component.showMore();
    expect(component.rows()).toHaveLength(450);
    expect(component.hiddenCount()).toBe(0);
    component.select('match');
    expect(component.rows()).toHaveLength(REPORT_PAGE_SIZE);
  });

  it('narrows the list by the search text, ignoring case and surrounding spaces', async () => {
    const files = Array.from({ length: 450 }, (_, i) => `f${i}.txt`);
    const component = await show({ match: 450 }, { match: files });
    fixture.componentRef.setInput('searchTerm', ' F44 ');
    expect(component.rows().map(row => row.path)).toEqual([
      'f44.txt',
      ...Array.from({ length: 10 }, (_, i) => `f44${i}.txt`),
    ]);
    fixture.componentRef.setInput('searchTerm', 'nothing like it');
    expect(component.rows()).toEqual([]);
  });

  it('says so when the report cannot be loaded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getJobReport.mockRejectedValue(new Error('gone'));
    fixture = TestBed.createComponent(JobReportComponent);
    fixture.componentRef.setInput('jobId', 42);
    fixture.componentRef.setInput('counts', { combined: 1 });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance.failed()).toBe(true);
    expect(fixture.componentInstance.rows()).toEqual([]);
    expect(fixture.nativeElement.querySelector('.empty-state')).not.toBeNull();
  });

  it('ignores a late answer for a job that is no longer shown', async () => {
    let answerFirst: (value: unknown) => void = () => undefined;
    getJobReport.mockImplementationOnce(() => new Promise(resolve => (answerFirst = resolve)));
    fixture = TestBed.createComponent(JobReportComponent);
    fixture.componentRef.setInput('jobId', 1);
    fixture.componentRef.setInput('counts', { match: 1 });
    fixture.detectChanges();
    getJobReport.mockResolvedValueOnce({ match: ['second.txt'] });
    fixture.componentRef.setInput('jobId', 2);
    fixture.detectChanges();
    await fixture.whenStable();
    answerFirst({ match: ['first.txt'] });
    await fixture.whenStable();
    expect(fixture.componentInstance.rows().map(row => row.path)).toEqual(['second.txt']);
  });
});
