import { describe, it, expect, beforeEach, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { RcConsoleResponse } from '@app/types';
import { BackendTranslationService } from '../../i18n/backend-translation.service';
import { NotificationService } from '../../ui/notification.service';
import { LocalStorageService } from '../../ui/state/local-storage.service';
import { ApiClientService } from '../platform/api-client.service';
import { BackendService } from './backend.service';
import { RcConsoleService } from './rc-console.service';

const commands = (...paths: string[]): RcConsoleResponse => ({
  ok: true,
  durationMs: 1,
  body: { commands: paths.map(Path => ({ Path, Title: '', Help: '' })) },
});

describe('RcConsoleService', () => {
  let service: RcConsoleService;
  let invoke: ReturnType<typeof vi.fn>;
  let activeBackend: ReturnType<typeof signal<string>>;

  beforeEach(() => {
    invoke = vi.fn();
    activeBackend = signal('Local');
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        { provide: ApiClientService, useValue: { invoke } },
        { provide: NotificationService, useValue: {} },
        { provide: BackendService, useValue: { activeBackend } },
        {
          provide: BackendTranslationService,
          useValue: { translateBackendMessage: (e: unknown): string => `translated:${e}` },
        },
        {
          provide: LocalStorageService,
          useValue: { get: (_k: string, d: unknown): unknown => d, set: vi.fn() },
        },
      ],
    });
    service = TestBed.inject(RcConsoleService);
  });

  describe('call', () => {
    it('returns what the backend answered', async () => {
      invoke.mockResolvedValue({ ok: true, durationMs: 4, body: { a: 1 } });
      expect(await service.call('core/version', { x: 1 })).toMatchObject({ ok: true });
      expect(invoke).toHaveBeenCalledWith('rc_console_call', {
        command: 'core/version',
        params: { x: 1 },
      });
    });

    it('turns a call that never reached rclone into a failed response', async () => {
      invoke.mockRejectedValue('boom');
      expect(await service.call('core/version')).toEqual({
        ok: false,
        durationMs: 0,
        body: { error: 'translated:boom' },
      });
    });
  });

  describe('loadCommands', () => {
    it('asks rclone once per backend', async () => {
      invoke.mockResolvedValue(commands('core/version'));
      await service.loadCommands();
      expect((await service.loadCommands()).map(c => c.Path)).toEqual(['core/version']);
      expect(invoke).toHaveBeenCalledTimes(1);

      activeBackend.set('NAS');
      await service.loadCommands();
      expect(invoke).toHaveBeenCalledTimes(2);
    });

    it('asks again when forced, for a rclone that was replaced by a new build', async () => {
      invoke.mockResolvedValueOnce(commands('core/version'));
      await service.loadCommands();

      invoke.mockResolvedValueOnce(commands('core/version', 'core/new-call'));
      expect(await service.loadCommands(true)).toHaveLength(2);
      expect(await service.loadCommands()).toHaveLength(2);
      expect(invoke).toHaveBeenCalledTimes(2);
    });

    it('does not keep an empty answer, so the next ask tries again', async () => {
      invoke.mockResolvedValueOnce({ ok: false, durationMs: 0, body: { error: 'down' } });
      expect(await service.loadCommands()).toEqual([]);

      invoke.mockResolvedValueOnce(commands('core/version'));
      expect(await service.loadCommands()).toHaveLength(1);
    });
  });

  describe('history and snippets', () => {
    it('keeps a line once, newest last', () => {
      service.addToHistory('core/version');
      service.addToHistory('core/stats');
      service.addToHistory('core/version');
      expect(service.history()).toEqual(['core/stats', 'core/version']);
    });

    it('never keeps a line that sets a secret', () => {
      service.addToHistory('config/create name=x pass=hunter2');
      expect(service.history()).toEqual([]);
      expect(service.saveSnippet('config/create name=x pass=hunter2')).toBe(false);
      expect(service.snippets()).toEqual([]);
    });

    it('saves and removes a snippet', () => {
      expect(service.saveSnippet('core/version')).toBe(true);
      expect(service.snippets()).toEqual(['core/version']);
      service.removeSnippet('core/version');
      expect(service.snippets()).toEqual([]);
    });
  });
});
