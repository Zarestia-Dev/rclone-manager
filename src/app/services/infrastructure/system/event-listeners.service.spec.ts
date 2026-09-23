import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { provideTranslateService } from '@ngx-translate/core';
import { EventListenersService } from './event-listeners.service';
import { ApiClientService } from '../platform/api-client.service';
import { SseClientService } from '../platform/sse-client.service';
import { SettingsChangeEvent } from '@app/types';

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
            listen: vi.fn(() => sseEventSubject.asObservable()),
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
