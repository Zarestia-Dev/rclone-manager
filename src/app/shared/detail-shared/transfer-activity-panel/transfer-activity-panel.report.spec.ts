import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Component, input } from '@angular/core';
import { provideTranslateService } from '@ngx-translate/core';
import { CompletedTransfer, TransferActivityPanelConfig } from '@app/types';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { TransferActivityPanelComponent } from './transfer-activity-panel.component';
import { CompletedTransfersTableComponent } from './completed-transfers-table.component';
import { ActiveTransfersTableComponent } from './active-transfers-table.component';
import { CheckResultsTableComponent } from './check-results-table.component';

@Component({ selector: 'app-completed-transfers-table', template: 'history', standalone: true })
class CompletedStub {
  readonly transfers = input<unknown>();
  readonly jobType = input<unknown>();
  readonly remoteName = input<unknown>();
  readonly searchTerm = input<unknown>();
  readonly statusFilter = input<unknown>();
}

@Component({ selector: 'app-active-transfers-table', template: 'active', standalone: true })
class ActiveStub {
  readonly transfers = input<unknown>();
  readonly checks = input<unknown>();
  readonly jobType = input<unknown>();
  readonly remoteName = input<unknown>();
  readonly searchTerm = input<unknown>();
  readonly isJobRunning = input<unknown>();
}

const done: CompletedTransfer = {
  jobid: 7,
  name: 'a.txt',
  status: 'completed',
  checked: false,
  error: '',
  size: 1,
  bytes: 1,
};

describe('TransferActivityPanelComponent with file reports', () => {
  let fixture: ComponentFixture<TransferActivityPanelComponent>;

  function render(config: Partial<TransferActivityPanelConfig>, running = false): HTMLElement {
    fixture = TestBed.createComponent(TransferActivityPanelComponent);
    fixture.componentRef.setInput('config', {
      activeTransfers: [],
      completedTransfers: [],
      remoteName: 'drive',
      showHistory: true,
      jobType: 'sync',
      ...config,
    });
    fixture.componentRef.setInput('isJobRunning', running);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [TransferActivityPanelComponent],
      providers: [
        provideTranslateService(),
        {
          provide: JobManagementService,
          useValue: { getJobReport: vi.fn().mockResolvedValue({ combined: ['+ a.txt'] }) },
        },
        { provide: IconService, useValue: {} },
      ],
    });
    TestBed.overrideComponent(TransferActivityPanelComponent, {
      remove: {
        imports: [
          CompletedTransfersTableComponent,
          ActiveTransfersTableComponent,
          CheckResultsTableComponent,
        ],
      },
      add: { imports: [CompletedStub, ActiveStub] },
    });
  });

  it('opens a finished job on its report, next to the history tab', async () => {
    const el = render({
      completedTransfers: [done],
      report: { jobId: 7, counts: { combined: 1 } },
    });
    await fixture.whenStable();
    fixture.detectChanges();
    const labels = Array.from(el.querySelectorAll('.activity-tab')).map(tab =>
      tab.textContent?.trim()
    );
    expect(labels).toEqual([
      'shared.transferActivity.tabs.report',
      'shared.transferActivity.tabs.recent',
    ]);
    expect(el.querySelector('app-job-report')).not.toBeNull();
    expect(el.querySelector('app-completed-transfers-table')).toBeNull();
  });

  it('shows the report alone when the job transferred nothing', () => {
    const el = render({
      showHistory: false,
      report: { jobId: 7, counts: { match: 4 } },
    });
    expect(el.querySelectorAll('.activity-tab')).toHaveLength(1);
    expect(el.querySelector('app-job-report')).not.toBeNull();
  });

  it('keeps the live view while the job runs, and the history when it kept no report', () => {
    const running = render({ report: { jobId: 7, counts: { combined: 1 } } }, true);
    expect(running.querySelector('app-job-report')).toBeNull();
    expect(running.querySelector('app-active-transfers-table')).not.toBeNull();

    const plain = render({ completedTransfers: [done] });
    expect(plain.querySelector('app-job-report')).toBeNull();
    expect(plain.querySelector('app-completed-transfers-table')).not.toBeNull();
  });
});
