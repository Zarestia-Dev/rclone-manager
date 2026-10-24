import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
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
    profile: 'daily',
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

  it('stops only the clicked job, even when another execution uses the same profile', async () => {
    const buttons: NodeListOf<HTMLButtonElement> =
      fixture.nativeElement.querySelectorAll('.action-button');
    buttons[1].click();
    await fixture.whenStable();
    expect(stopJob).toHaveBeenCalledExactlyOnceWith(202, 'drive');
    expect(openJobDetail).not.toHaveBeenCalled();
  });

  it('does not fall back to another execution when stopping fails', async () => {
    const error = new Error('already finished');
    stopJob.mockRejectedValueOnce(error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(fixture.componentInstance.onStopJob(first)).resolves.toBeUndefined();
      expect(stopJob).toHaveBeenCalledExactlyOnceWith(101, 'drive');
      expect(log).toHaveBeenCalledWith('Failed to stop job:', error);
    } finally {
      log.mockRestore();
    }
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
});
