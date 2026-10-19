import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientService } from './api-client.service';
import { SseClientService, SseEvent } from './sse-client.service';

class MockEventSource {
  static instances: MockEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  close = vi.fn();

  constructor(
    readonly url: string,
    readonly options: EventSourceInit
  ) {
    MockEventSource.instances.push(this);
  }
}

describe('SseClientService connection ownership', () => {
  let service: SseClientService;
  const invoke = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
    invoke.mockReset().mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiClientService, useValue: { invoke, getApiBase: (): string => '/api' } },
      ],
    });
    service = TestBed.inject(SseClientService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shares concurrent connection requests and opens one authenticated source', async () => {
    const first = service.connect();
    expect(service.connect()).toBe(first);
    await first;
    await service.connect();
    expect(invoke).toHaveBeenCalledOnce();
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe('/api/events');
    expect(MockEventSource.instances[0].options).toEqual({ withCredentials: true });
  });

  it('does not reopen after disconnecting during authentication', async () => {
    let resolve!: () => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise<void>(done => {
          resolve = done;
        })
    );
    const pending = service.connect();
    service.disconnect();
    resolve();
    await pending;
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('does not let an old authentication response overwrite a newer connection', async () => {
    let resolve!: () => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise<void>(done => {
          resolve = done;
        })
    );
    const old = service.connect();
    service.disconnect();
    await service.connect();
    resolve();
    await old;
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].close).not.toHaveBeenCalled();
  });

  it('still opens the source when the optional authentication request fails', async () => {
    invoke.mockRejectedValueOnce(new Error('session unavailable'));
    await service.connect();
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it('retries once after repeated errors and ignores stale source callbacks', async () => {
    await service.connect();
    const old = MockEventSource.instances[0];
    const received: SseEvent[] = [];
    service.listenAll().subscribe(event => received.push(event));
    old.onerror?.();
    old.onerror?.();
    vi.advanceTimersByTime(1000);
    expect(MockEventSource.instances).toHaveLength(2);
    const current = MockEventSource.instances[1];
    old.onerror?.();
    old.onopen?.();
    old.onmessage?.({ data: '{"event":"stale","payload":1}' });
    expect(old.close).toHaveBeenCalledOnce();
    expect(current.close).not.toHaveBeenCalled();
    expect(received).toEqual([]);
    current.onmessage?.({ data: '{"event":"current","payload":2}' });
    expect(received).toEqual([{ event: 'current', payload: 2 }]);
  });

  it('cancels scheduled retries when explicitly connecting or disconnecting', async () => {
    await service.connect();
    MockEventSource.instances[0].onerror?.();
    await service.connect();
    vi.advanceTimersByTime(5000);
    expect(MockEventSource.instances).toHaveLength(2);
    MockEventSource.instances[1].onerror?.();
    service.disconnect();
    vi.advanceTimersByTime(5000);
    expect(MockEventSource.instances).toHaveLength(2);
  });

  it('ignores malformed and keep-alive frames while forwarding valid payloads', async () => {
    await service.connect();
    const received: SseEvent[] = [];
    service.listenAll().subscribe(event => received.push(event));
    const source = MockEventSource.instances[0];
    for (const data of ['keep-alive', '{invalid', '{"event":"ready","payload":null}', '42']) {
      source.onmessage?.({ data });
    }
    expect(received).toEqual([
      { event: 'ready', payload: null },
      { event: 'message', payload: 42 },
    ]);
  });

  it('cancels authentication and completes event streams when destroyed', async () => {
    let resolve!: () => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise<void>(done => {
          resolve = done;
        })
    );
    const completed = vi.fn();
    service.listenAll().subscribe({ complete: completed });
    const pending = service.connect();
    TestBed.resetTestingModule();
    resolve();
    await pending;
    expect(MockEventSource.instances).toHaveLength(0);
    expect(completed).toHaveBeenCalledOnce();
  });
});
