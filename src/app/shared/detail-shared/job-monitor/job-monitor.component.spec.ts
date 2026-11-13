import { beforeEach, describe, expect, it } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DEFAULT_JOB_STATS, GlobalStats, JobMonitorConfig } from '@app/types';
import { BackendTranslationService } from 'src/app/services/i18n/backend-translation.service';
import { JobMonitorComponent } from './job-monitor.component';

const stats = (extra: Partial<GlobalStats> = {}): GlobalStats => ({
  ...DEFAULT_JOB_STATS,
  ...extra,
});

const config = (extra: Partial<JobMonitorConfig> = {}): JobMonitorConfig => ({
  jobType: 'sync',
  title: 'Sync',
  icon: 'sync',
  jobId: 11,
  status: 'Running',
  running: true,
  stats: stats(),
  activity: {
    activeTransfers: [],
    completedTransfers: [],
    remoteName: 'drive',
    showHistory: false,
    jobType: 'sync',
  },
  ...extra,
});

describe('JobMonitorComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: BackendTranslationService,
          useValue: {
            translateBackendMessage: (message: unknown): string =>
              typeof message === 'string' ? message.toUpperCase() : '',
          },
        },
      ],
    });
    TestBed.overrideComponent(JobMonitorComponent, { set: { template: '', imports: [] } });
  });

  const create = (initial: JobMonitorConfig): ComponentFixture<JobMonitorComponent> => {
    const fixture = TestBed.createComponent(JobMonitorComponent);
    fixture.componentRef.setInput('config', initial);
    fixture.detectChanges();
    return fixture;
  };
  const speeds = (fixture: ComponentFixture<JobMonitorComponent>): number[] =>
    fixture.componentInstance['speedHistory']();

  it('shows the failure text translated, and nothing while the job has not failed', () => {
    const failed = create(config({ error: 'permission denied' }));
    expect(failed.componentInstance['error']()).toBe('PERMISSION DENIED');
    failed.componentRef.setInput('config', config({ error: undefined }));
    failed.detectChanges();
    expect(failed.componentInstance['error']()).toBeNull();
  });

  it('collects the speed of every stats update while the job runs', () => {
    const fixture = create(config({ stats: stats({ speed: 10 }) }));
    fixture.componentRef.setInput('config', config({ stats: stats({ speed: 30 }) }));
    fixture.detectChanges();
    fixture.componentRef.setInput('config', config({ stats: stats({ speed: 20 }) }));
    fixture.detectChanges();
    expect(speeds(fixture)).toEqual([10, 30, 20]);
    expect(fixture.componentInstance['kpis']().find(kpi => kpi.key === 'speed')).toMatchObject({
      value: 20,
      sparkline: true,
    });
  });

  it('does not sample again when only something other than the stats changed', () => {
    const shared = stats({ speed: 5 });
    const fixture = create(config({ stats: shared }));
    fixture.componentRef.setInput('config', config({ stats: shared, title: 'Renamed' }));
    fixture.detectChanges();
    expect(speeds(fixture)).toEqual([5]);
  });

  it('keeps no history for a job that is not running', () => {
    const fixture = create(
      config({ running: false, status: 'Completed', stats: stats({ speed: 9 }) })
    );
    expect(speeds(fixture)).toEqual([]);
    expect(fixture.componentInstance['spark']().line).toBe('');
  });

  it('starts a fresh history for another job', () => {
    const fixture = create(config({ stats: stats({ speed: 10 }) }));
    fixture.componentRef.setInput('config', config({ jobId: 12, stats: stats({ speed: 40 }) }));
    fixture.detectChanges();
    expect(speeds(fixture)).toEqual([40]);
  });

  it('shows the state of the job as a pill, and none when no job has run', () => {
    const component = create(config())['componentInstance'];
    expect(component['statusPill']()?.textKey).toBe('shared.monitor.status.running');
    const failed = create(config({ status: 'Failed', running: false }))['componentInstance'];
    expect(failed['statusPill']()).toMatchObject({
      tone: 'warn',
      textKey: 'shared.monitor.status.failed',
    });
    expect(create(config({ status: undefined }))['componentInstance']['statusPill']()).toBeNull();
  });

  it('builds the figures of a check from its comparison rows', () => {
    const fixture = create(
      config({
        jobType: 'check',
        running: false,
        status: 'Completed',
        activity: {
          activeTransfers: [],
          remoteName: 'drive',
          showHistory: true,
          jobType: 'check',
          completedTransfers: [
            {
              jobid: 11,
              name: 'a',
              size: 1,
              bytes: 0,
              checked: true,
              error: '',
              status: 'checked',
            },
            {
              jobid: 11,
              name: 'b',
              size: 1,
              bytes: 0,
              checked: true,
              error: '',
              status: 'partial',
            },
          ],
        },
      })
    );
    const kpis = fixture.componentInstance['kpis']();
    expect(kpis.find(kpi => kpi.key === 'matched')?.value).toBe(1);
    expect(kpis.find(kpi => kpi.key === 'differences')?.value).toBe(1);
  });

  it('has no figures to show before a job has run, and has them while one runs or once it has finished', () => {
    const idle = create(config({ jobId: undefined, running: false, status: undefined }));
    expect(idle.componentInstance['hasJob']()).toBe(false);
    expect(
      create(config({ jobId: undefined, running: true }))['componentInstance']['hasJob']()
    ).toBe(true);
    expect(create(config({ jobId: 4, running: false }))['componentInstance']['hasJob']()).toBe(
      true
    );
  });
});
