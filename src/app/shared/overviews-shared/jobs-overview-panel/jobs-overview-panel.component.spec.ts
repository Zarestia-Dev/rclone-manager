import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { signal } from '@angular/core';
import { JobsOverviewPanelComponent } from './jobs-overview-panel.component';
import { JobInfo } from '@app/types';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { RcloneStatusService } from 'src/app/services/infrastructure/maintenance/rclone-status.service';

describe('JobsOverviewPanelComponent', () => {
  let component: JobsOverviewPanelComponent;
  let fixture: ComponentFixture<JobsOverviewPanelComponent>;

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

    await TestBed.configureTestingModule({
      imports: [JobsOverviewPanelComponent],
      providers: [
        provideTranslateService(),
        { provide: JobManagementService, useValue: mockJobService },
        { provide: RcloneStatusService, useValue: mockStatusService },
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
});
