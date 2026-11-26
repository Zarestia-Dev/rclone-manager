import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_JOB_STATS, JobInfo } from '@app/types';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { ModalService } from 'src/app/services/ui/modal.service';
import { JobsPanelComponent } from './jobs-panel.component';

describe('JobsPanelComponent job actions', () => {
  let fixture: ComponentFixture<JobsPanelComponent>;
  const stopJob = vi.fn<JobManagementService['stopJob']>();
  const openJobDetail = vi.fn();
  const jobs = signal<JobInfo[]>([]);
  const first: JobInfo = {
    jobid: 101,
    execute_id: 'first',
    job_type: 'sync',
    remote_name: 'drive',
    starter: { kind: 'profile', name: 'daily' },
    source: 'drive:',
    destination: 'backup:',
    start_time: '2026-09-02T10:00:00Z',
    status: 'Running',
    stats: { ...DEFAULT_JOB_STATS },
  };

  beforeEach(() => {
    stopJob.mockReset().mockResolvedValue(undefined);
    openJobDetail.mockReset();
    jobs.set([first, { ...first, jobid: 202, execute_id: 'second' }]);
    TestBed.configureTestingModule({
      imports: [JobsPanelComponent],
      providers: [
        provideTranslateService(),
        { provide: JobManagementService, useValue: { jobs, stopJob } },
        { provide: ModalService, useValue: { openJobDetail } },
      ],
    });
    fixture = TestBed.createComponent(JobsPanelComponent);
    fixture.componentRef.setInput('config', { jobs: jobs() });
    fixture.detectChanges();
  });

  it('names what started each job: its profile or its Quick Run', () => {
    const jobsWith = (starter: JobInfo['starter'], jobid: number): JobInfo => ({
      ...first,
      jobid,
      execute_id: `exec-${jobid}`,
      starter,
    });
    fixture.componentRef.setInput('config', {
      jobs: [
        jobsWith({ kind: 'profile', name: 'Test 1' }, 1),
        jobsWith({ kind: 'quick_run', id: 'qr-1', name: 'Nightly' }, 2),
        jobsWith(undefined, 3),
      ],
    });
    fixture.detectChanges();

    const pills = [...fixture.nativeElement.querySelectorAll('.card-row-item')].map(
      (row: HTMLElement) => row.querySelector('app-starter-pill [appPill]')?.textContent?.trim()
    );
    expect(pills).toEqual(['Test 1', 'Nightly', undefined]);
  });

  it.each(['Enter', ' '])('opens a job on %j pressed on its row, not on its stop button', key => {
    const row: HTMLElement = fixture.nativeElement.querySelector('.card-row-item');
    const press = (target: HTMLElement): KeyboardEvent => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    };

    expect(press(row.querySelector('.action-button') as HTMLElement).defaultPrevented).toBe(false);
    expect(openJobDetail).not.toHaveBeenCalled();

    expect(press(row).defaultPrevented).toBe(true);
    expect(openJobDetail).toHaveBeenCalledTimes(1);
  });

  it('stops only the clicked job, even when another execution uses the same profile', async () => {
    const buttons: NodeListOf<HTMLButtonElement> =
      fixture.nativeElement.querySelectorAll('.action-button');
    buttons[1].click();
    await fixture.whenStable();
    expect(stopJob).toHaveBeenCalledExactlyOnceWith(202);
    expect(openJobDetail).not.toHaveBeenCalled();
  });

  it('does not fall back to another execution when stopping fails', async () => {
    const error = new Error('already finished');
    stopJob.mockRejectedValueOnce(error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(fixture.componentInstance.onStopJob(first)).resolves.toBeUndefined();
      expect(stopJob).toHaveBeenCalledExactlyOnceWith(101);
      expect(log).toHaveBeenCalledWith('Failed to stop job:', error);
    } finally {
      log.mockRestore();
    }
  });

  it('shows a localized backend error as text, not as its raw JSON', () => {
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', { backendErrors: { job: { lost: 'Rclone lost this job' } } });
    translate.use('en');
    const lost = '{"key":"backendErrors.job.lost","params":{}}';
    fixture.componentRef.setInput('config', {
      jobs: [{ ...first, status: 'Failed', error: lost }],
    });
    fixture.detectChanges();
    const title = fixture.nativeElement.querySelector('.has-error')?.getAttribute('title');
    expect(title).toBe('Rclone lost this job');
  });

  it('keeps deleting a finished job separate from stopping a running job', () => {
    fixture.componentRef.setInput('config', { jobs: [{ ...first, status: 'Completed' }] });
    fixture.detectChanges();
    const deleted = vi.spyOn(fixture.componentInstance.deleteJob, 'emit');
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.action-button');
    button.click();
    expect(deleted).toHaveBeenCalledExactlyOnceWith(101);
    expect(stopJob).not.toHaveBeenCalled();
    expect(openJobDetail).not.toHaveBeenCalled();
  });

  it('names where a job was started unless its Quick Run already says so', () => {
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', {
      alerts: { origins: { filemanager: 'File Manager', dashboard: 'Dashboard' } },
    });
    translate.use('en');
    fixture.componentRef.setInput('config', {
      jobs: [
        { ...first, jobid: 1, execute_id: 'fm', starter: undefined, origin: 'filemanager' },
        { ...first, jobid: 2, execute_id: 'dash', origin: 'dashboard' },
        {
          ...first,
          jobid: 3,
          execute_id: 'qr',
          origin: 'dashboard',
          starter: { kind: 'quick_run', id: 'qr-1', name: 'Nightly' },
        },
      ],
    });
    fixture.detectChanges();
    const origins = [...fixture.nativeElement.querySelectorAll('.card-row-item')].map(
      (row: HTMLElement) => row.querySelector('.job-tags > [appPill]')?.textContent?.trim()
    );
    expect(origins).toEqual(['File Manager', 'Dashboard', undefined]);
  });

  it('shows its "Jobs" title unless the page names the list itself', () => {
    const title = (): string | undefined =>
      fixture.nativeElement.querySelector('mat-card-title span')?.textContent?.trim();
    expect(title()).toBe('detailShared.jobs.title');
    fixture.componentRef.setInput('config', { jobs: [], hideTitle: true });
    fixture.detectChanges();
    expect(title()).toBeUndefined();
  });
});
