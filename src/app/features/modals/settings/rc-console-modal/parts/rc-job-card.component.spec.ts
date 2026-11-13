import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { RcConsoleResponse } from '@app/types';
import { RcConsoleService } from '../../../../../services/infrastructure/system/rc-console.service';
import { NotificationService } from '../../../../../services/ui/notification.service';
import { RcJobCardComponent } from './rc-job-card.component';

const ok = (body: unknown): RcConsoleResponse => ({ ok: true, durationMs: 1, body });

describe('RcJobCardComponent', () => {
  let fixture: ComponentFixture<RcJobCardComponent>;
  let component: RcJobCardComponent;
  let call: ReturnType<typeof vi.fn>;

  const status = (over: Record<string, unknown> = {}): RcConsoleResponse =>
    ok({ finished: false, success: false, error: '', duration: 1, group: 'job/7', ...over });

  async function flush(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    call = vi.fn();
    await TestBed.configureTestingModule({
      imports: [RcJobCardComponent],
      providers: [
        provideTranslateService(),
        { provide: RcConsoleService, useValue: { call } },
        { provide: NotificationService, useValue: {} },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(RcJobCardComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('jobId', 7);
  });

  afterEach(() => vi.useRealTimers());

  it('polls the status and the group stats until the job finishes', async () => {
    call.mockImplementation(async (cmd: string) => {
      if (cmd === 'core/stats') return ok({ bytes: 50, totalBytes: 100, totalTransfers: 1 });
      return call.mock.calls.filter(c => c[0] === 'job/status').length < 3
        ? status()
        : status({ finished: true, success: true, output: { done: true } });
    });

    fixture.detectChanges();
    await flush();
    expect(component.job()?.finished).toBe(false);
    expect(component.progress()?.percent).toBe(50);
    expect(call).toHaveBeenCalledWith('job/status', { jobid: 7 });
    expect(call).toHaveBeenCalledWith('core/stats', { group: 'job/7' });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    fixture.detectChanges();
    expect(component.job()?.finished).toBe(true);

    const calls = call.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(call.mock.calls.length).toBe(calls);
    expect(fixture.nativeElement.querySelector('app-rc-output')).not.toBeNull();
  });

  it('reports a job that cannot be found and stops polling', async () => {
    call.mockResolvedValue({
      ok: false,
      status: 500,
      durationMs: 1,
      body: { error: 'job not found' },
    });
    fixture.detectChanges();
    await flush();
    expect(component.lookupError()).toBe('job not found');

    await vi.advanceTimersByTimeAsync(5000);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('keeps following the job through a dropped request', async () => {
    const calls: string[] = [];
    call.mockImplementation(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === 'core/stats') return ok({});
      if (calls.filter(c => c === 'job/status').length === 1) {
        return { ok: false, durationMs: 0, body: { error: 'connection reset' } };
      }
      return status({ finished: true, success: true, output: {} });
    });

    fixture.detectChanges();
    await flush();
    expect(component.lookupError()).toBeNull();
    expect(component.job()).toBeNull();

    await vi.advanceTimersByTimeAsync(1000);
    fixture.detectChanges();
    expect(component.job()?.finished).toBe(true);
    expect(component.lookupError()).toBeNull();
  });

  it('gives up after three dropped requests in a row', async () => {
    call.mockResolvedValue({ ok: false, durationMs: 0, body: { error: 'connection reset' } });
    fixture.detectChanges();
    await flush();
    await vi.advanceTimersByTimeAsync(3000);
    expect(component.lookupError()).toBe('connection reset');
    expect(call).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(5000);
    expect(call).toHaveBeenCalledTimes(4);
  });

  it('treats a rejected request like a dropped one', async () => {
    call.mockRejectedValueOnce(new Error('ipc'));
    call.mockResolvedValue(status({ finished: true, success: true, output: {} }));
    fixture.detectChanges();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(component.lookupError()).toBeNull();
    expect(component.job()?.finished).toBe(true);
  });

  it('shows a failed job with its error', async () => {
    call.mockResolvedValue(status({ finished: true, success: false, error: 'boom' }));
    fixture.detectChanges();
    await flush();
    expect(fixture.nativeElement.querySelector('.error').textContent).toBe('boom');
  });

  it('stops the job on request', async () => {
    call.mockResolvedValue(status());
    fixture.detectChanges();
    await flush();
    await component.stop();
    expect(call).toHaveBeenCalledWith('job/stop', { jobid: 7 });
    expect(component.stopping()).toBe(false);
  });

  it('stops polling when it is destroyed', async () => {
    call.mockResolvedValue(status());
    fixture.detectChanges();
    await flush();
    const calls = call.mock.calls.length;
    fixture.destroy();
    await vi.advanceTimersByTimeAsync(5000);
    expect(call.mock.calls.length).toBe(calls);
  });
});
