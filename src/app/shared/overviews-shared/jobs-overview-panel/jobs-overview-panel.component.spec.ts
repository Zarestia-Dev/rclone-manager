import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { signal } from '@angular/core';
import { JobsOverviewPanelComponent } from './jobs-overview-panel.component';
import { JobInfo } from '@app/types';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { RcloneStatusService } from 'src/app/services/infrastructure/maintenance/rclone-status.service';
import { ModalService } from 'src/app/services/ui/modal.service';

describe('JobsOverviewPanelComponent', () => {
  let component: JobsOverviewPanelComponent;
  let fixture: ComponentFixture<JobsOverviewPanelComponent>;
  let mockModalService: { openJobDetail: ReturnType<typeof vi.fn> };

  const mockJobs = [
    {
      id: 1,
      job_id: 1,
      job_type: 'sync',
      remote: 'drive:',
      status: 'Running',
      progress: 50,
      stats: { bytes: 100, totalBytes: 200 },
      start_time: '2026-09-02T10:00:00Z',
      origin: 'flow',
      duration: '10s',
    },
    {
      id: 2,
      job_id: 2,
      job_type: 'copy',
      remote: 's3:',
      status: 'Running',
      progress: 20,
      stats: { bytes: 20, totalBytes: 100 },
      start_time: '2026-09-02T10:05:00Z',
      origin: 'quickrun',
      duration: '5s',
    },
    {
      id: 3,
      job_id: 3,
      job_type: 'move',
      remote: 'dropbox:',
      status: 'Running',
      progress: 80,
      stats: { bytes: 80, totalBytes: 100 },
      start_time: '2026-09-02T10:10:00Z',
      origin: 'dashboard',
      duration: '2s',
    },
  ] as unknown as JobInfo[];

  beforeEach(async () => {
    const mockJobService = {
      jobs: signal(mockJobs),
    };
    const mockStatusService = {
      jobStats: signal({ bytes: 200, totalBytes: 400, speed: 23 }),
      isLoading: signal(false),
    };
    mockModalService = {
      openJobDetail: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [JobsOverviewPanelComponent],
      providers: [
        provideTranslateService(),
        { provide: JobManagementService, useValue: mockJobService },
        { provide: RcloneStatusService, useValue: mockStatusService },
        { provide: ModalService, useValue: mockModalService },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(JobsOverviewPanelComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('filters running jobs correctly by flow origin', () => {
    expect(component.runningJobs().length).toBe(3);

    component.selectedOriginFilter.set('flow');
    fixture.detectChanges();
    expect(component.runningJobs().length).toBe(1);
    expect(component.runningJobs()[0].origin).toBe('flow');
  });

  it('filters running jobs correctly by quickrun origin', () => {
    component.selectedOriginFilter.set('quickrun');
    fixture.detectChanges();
    expect(component.runningJobs().length).toBe(1);
    expect(component.runningJobs()[0].origin).toBe('quickrun');
  });

  it('filters running jobs correctly by dashboard origin', () => {
    component.selectedOriginFilter.set('dashboard');
    fixture.detectChanges();
    expect(component.runningJobs().length).toBe(1);
    expect(component.runningJobs()[0].origin).toBe('dashboard');
  });

  it('returns correct origin labels and badge classes', () => {
    expect(component.getOriginLabel('flow')).toBe('Flow');
    expect(component.getOriginBadgeClass('flow')).toBe('p-accent');

    expect(component.getOriginLabel('quickrun')).toBe('Quick Run');
    expect(component.getOriginBadgeClass('quickrun')).toBe('p-primary');

    expect(component.getOriginLabel('dashboard')).toBe('Dashboard');
    expect(component.getOriginBadgeClass('dashboard')).toBe('p-dim');
  });

  it('opens job detail modal on job row click', () => {
    const job = mockJobs[0];
    component.onJobRowClick(job);
    expect(mockModalService.openJobDetail).toHaveBeenCalledWith(job);
  });

  it('assigns correct job type and animation classes', () => {
    expect(component.getJobTypeClass({ job_type: 'sync' } as unknown as JobInfo)).toBe(
      'type-primary'
    );
    expect(component.getJobTypeClass({ job_type: 'copy' } as unknown as JobInfo)).toBe(
      'type-yellow'
    );
    expect(component.getJobTypeClass({ job_type: 'move' } as unknown as JobInfo)).toBe(
      'type-orange'
    );
    expect(component.getJobTypeClass({ job_type: 'mount' } as unknown as JobInfo)).toBe(
      'type-accent'
    );

    expect(component.getJobAnimationClass({ job_type: 'sync' } as unknown as JobInfo)).toBe(
      'animate-spin'
    );
    expect(component.getJobAnimationClass({ job_type: 'bisync' } as unknown as JobInfo)).toBe(
      'animate-spin'
    );
    expect(component.getJobAnimationClass({ job_type: 'copy' } as unknown as JobInfo)).toBe('');
  });

  it('computes runningJobViewModels with correct progress percentage', () => {
    const vms = component.runningJobViewModels();
    expect(vms.length).toBe(3);
    expect(vms[0].progressPercentage).toBe(50); // 100 / 200 = 50%
    expect(vms[1].progressPercentage).toBe(20); // 20 / 100 = 20%
    expect(vms[2].progressPercentage).toBe(80); // 80 / 100 = 80%
  });

  it('returns formatted job label using translation or fallback', () => {
    expect(component.getJobLabel({ job_type: 'sync' } as unknown as JobInfo)).toBeDefined();
    expect(component.getJobLabel({ job_type: 'custom_op' } as unknown as JobInfo)).toBe(
      'custom op'
    );
  });
});
