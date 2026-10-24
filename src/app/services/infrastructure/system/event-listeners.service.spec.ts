import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, Subject, filter, map } from 'rxjs';
import { provideTranslateService } from '@ngx-translate/core';
import { EventListenersService } from './event-listeners.service';
import { ApiClientService } from '../platform/api-client.service';
import { SseClientService } from '../platform/sse-client.service';
import {
  AppEventPayload,
  APP_EVENT,
  EngineStatus,
  RCLONE_ENGINE_STATUS_CHANGED,
  SettingsChangeEvent,
} from '@app/types';

describe('EventListenersService', () => {
  let service: EventListenersService;
  let sseEventSubject: Subject<{ event: string; payload: unknown }>;

  beforeEach(() => {
    vi.useFakeTimers();
    sseEventSubject = new Subject();

    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        EventListenersService,
        {
          provide: ApiClientService,
          useValue: {
            invoke: vi.fn(),
            get: vi.fn(),
            post: vi.fn(),
          },
        },
        {
          provide: SseClientService,
          useValue: {
            listen: vi.fn((name: string) =>
              sseEventSubject.pipe(
                filter(event => event.event === name),
                map(event => event.payload)
              )
            ),
          },
        },
      ],
    });

    service = TestBed.inject(EventListenersService);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits for native exit-listener registration before reporting readiness', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__');
    let finish!: (eventId: number) => void;
    const invoke = vi.fn(
      () =>
        new Promise<number>(resolve => {
          finish = resolve;
        })
    );
    try {
      Object.defineProperty(window, '__TAURI_INTERNALS__', {
        value: { invoke, transformCallback: vi.fn(() => 1) },
        configurable: true,
      });
      const nativeService = TestBed.runInInjectionContext(() => new EventListenersService());
      nativeService.listenToAppExitRequested();
      let ready = false;
      const registration = firstValueFrom(nativeService.whenAppExitListenerReady()).then(() => {
        ready = true;
      });
      await Promise.resolve();
      expect(ready).toBe(false);
      finish(1);
      await registration;
      expect(ready).toBe(true);
    } finally {
      if (descriptor) Object.defineProperty(window, '__TAURI_INTERNALS__', descriptor);
      else Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    }
  });

  it('shares engine events while the ready subscription filters other status changes', () => {
    const statuses: EngineStatus[] = [];
    const ready = vi.fn();
    const all = service.listenToEngineStatus().subscribe(event => statuses.push(event));
    const onlyReady = service.listenToRcloneEngineReady().subscribe(ready);
    const updating: EngineStatus = { status: 'updating' };
    const available: EngineStatus = { status: 'ready' };

    sseEventSubject.next({ event: 'unrelated', payload: available });
    sseEventSubject.next({ event: RCLONE_ENGINE_STATUS_CHANGED, payload: updating });
    expect(ready).not.toHaveBeenCalled();
    sseEventSubject.next({ event: RCLONE_ENGINE_STATUS_CHANGED, payload: available });
    expect(statuses).toEqual([updating, available]);
    expect(ready).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(TestBed.inject(SseClientService).listen).toHaveBeenCalledExactlyOnceWith(
      RCLONE_ENGINE_STATUS_CHANGED
    );
    all.unsubscribe();
    onlyReady.unsubscribe();
  });

  it('delivers the application event payload without reshaping its fields', () => {
    const received: AppEventPayload[] = [];
    const subscription = service.listenToAppEvents().subscribe(event => received.push(event));
    const payload: AppEventPayload = { status: 'language_changed', language: 'tr-TR' };
    sseEventSubject.next({ event: APP_EVENT, payload });
    expect(received).toEqual([payload]);
    subscription.unsubscribe();
  });

  describe('listenToSettingsCategory', () => {
    it('should emit when event category matches requested category', () => {
      const changeSubject = new Subject<SettingsChangeEvent>();
      vi.spyOn(service, 'listenToSystemSettingsChanged').mockReturnValue(
        changeSubject.asObservable()
      );

      const emitted: SettingsChangeEvent[] = [];
      const sub = service.listenToSettingsCategory('quick_runs').subscribe(e => emitted.push(e));

      changeSubject.next({ category: 'quick_runs', key: 'item1', value: 'data' });
      vi.advanceTimersByTime(50);

      expect(emitted).toEqual([{ category: 'quick_runs', key: 'item1', value: 'data' }]);

      sub.unsubscribe();
    });

    it('should emit when wildcard category is received', () => {
      const changeSubject = new Subject<SettingsChangeEvent>();
      vi.spyOn(service, 'listenToSystemSettingsChanged').mockReturnValue(
        changeSubject.asObservable()
      );

      const emitted: SettingsChangeEvent[] = [];
      const sub = service.listenToSettingsCategory('workflows').subscribe(e => emitted.push(e));

      changeSubject.next({ category: '*', key: '*', value: null });
      vi.advanceTimersByTime(50);

      expect(emitted).toEqual([{ category: '*', key: '*', value: null }]);

      sub.unsubscribe();
    });

    it('should ignore events from unrelated categories', () => {
      const changeSubject = new Subject<SettingsChangeEvent>();
      vi.spyOn(service, 'listenToSystemSettingsChanged').mockReturnValue(
        changeSubject.asObservable()
      );

      const emitted: SettingsChangeEvent[] = [];
      const sub = service.listenToSettingsCategory('templates').subscribe(e => emitted.push(e));

      changeSubject.next({ category: 'notifications', key: 'enabled', value: true });
      vi.advanceTimersByTime(100);

      expect(emitted).toEqual([]);

      sub.unsubscribe();
    });
  });
});
