import { describe, it, expect, beforeEach, vi } from 'vitest';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { RcCommandInfo, RcConsoleResponse } from '@app/types';
import { RemoteFacadeService } from '../../../../services/facade/remote-facade.service';
import { RcloneStatusService } from '../../../../services/infrastructure/maintenance/rclone-status.service';
import { BackendService } from '../../../../services/infrastructure/system/backend.service';
import { RcConsoleService } from '../../../../services/infrastructure/system/rc-console.service';
import { SystemInfoService } from '../../../../services/infrastructure/system/system-info.service';
import { NotificationService } from '../../../../services/ui/notification.service';
import { RcConsoleModalComponent } from './rc-console-modal.component';

const command = (Path: string, Title = '', Help = ''): RcCommandInfo => ({
  Path,
  Title,
  Help: Help || `${Title} help`,
});

const LIST_HELP = `Parameters:

- fs - a remote name string
- remote - a path within that remote

Returns:

- list`;

describe('RcConsoleModalComponent', () => {
  let fixture: ComponentFixture<RcConsoleModalComponent>;
  let component: RcConsoleModalComponent;
  let backendName: ReturnType<typeof signal<string>>;
  let status: {
    rcloneInfo: ReturnType<typeof signal<{ version: string } | null>>;
    rclonePID: ReturnType<typeof signal<number | null>>;
    rcloneStatus: ReturnType<typeof signal<string>>;
    refreshStatus: ReturnType<typeof vi.fn>;
  };
  let systemInfo: {
    isLibrclone: ReturnType<typeof vi.fn>;
    killProcess: ReturnType<typeof vi.fn>;
  };
  let notifications: {
    showInfo: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
  };
  let service: {
    history: ReturnType<typeof signal<readonly string[]>>;
    snippets: ReturnType<typeof signal<readonly string[]>>;
    loadCommands: ReturnType<typeof vi.fn>;
    call: ReturnType<typeof vi.fn>;
    addToHistory: ReturnType<typeof vi.fn>;
    saveSnippet: ReturnType<typeof vi.fn>;
    removeSnippet: ReturnType<typeof vi.fn>;
  };

  const ok = (body: unknown): RcConsoleResponse => ({ ok: true, durationMs: 4, body });
  const keydown = (key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key, cancelable: true, ...init });
    component.onKeydown(event);
    return event;
  };

  async function configure(data: unknown = null): Promise<void> {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [RcConsoleModalComponent],
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: { close: vi.fn() } },
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: RcConsoleService, useValue: service },
        { provide: BackendService, useValue: { activeBackend: backendName } },
        { provide: RcloneStatusService, useValue: status },
        { provide: SystemInfoService, useValue: systemInfo },
        {
          provide: RemoteFacadeService,
          useValue: {
            orderedVisibleRemotes: (): { name: string }[] => [
              { name: 'gdrive' },
              { name: 'dropbox' },
            ],
          },
        },
        { provide: NotificationService, useValue: notifications },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(RcConsoleModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
  }

  beforeEach(async () => {
    backendName = signal('Local');
    status = {
      rcloneInfo: signal({ version: 'v1.70.0' }),
      rclonePID: signal<number | null>(4242),
      rcloneStatus: signal('active'),
      refreshStatus: vi.fn().mockResolvedValue(undefined),
    };
    systemInfo = {
      isLibrclone: vi.fn().mockResolvedValue(false),
      killProcess: vi.fn().mockResolvedValue(undefined),
    };
    notifications = { showInfo: vi.fn(), showError: vi.fn() };
    service = {
      history: signal<readonly string[]>([]),
      snippets: signal<readonly string[]>([]),
      loadCommands: vi
        .fn()
        .mockResolvedValue([
          command('core/version', 'Shows the version'),
          command('operations/list', 'List files', LIST_HELP),
          command('operations/purge', 'Remove a directory'),
        ]),
      call: vi.fn().mockResolvedValue(ok({ version: 'v1.70.0' })),
      addToHistory: vi.fn(),
      saveSnippet: vi.fn().mockReturnValue(true),
      removeSnippet: vi.fn(),
    };

    await configure();
  });

  it('loads the command list for suggestions', () => {
    expect(component.loadState()).toBe('ready');
    component.onInput('oper');
    expect(component.suggestions().map(s => s.label)).toEqual([
      'operations/list',
      'operations/purge',
    ]);
  });

  it('reports suggestions as unavailable when rc/list returns nothing', async () => {
    service.loadCommands.mockResolvedValue([]);
    await configure();
    expect(component.loadState()).toBe('unavailable');
  });

  it('starts with the line it was opened with', async () => {
    await configure({ line: 'operations/list fs=gdrive:' });
    expect(component.line()).toBe('operations/list fs=gdrive:');
  });

  it('tells assistive technology which suggestion is highlighted', () => {
    component.onInput('operations/');
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    const input = root.querySelector('textarea') as HTMLTextAreaElement;
    const options = [...root.querySelectorAll<HTMLElement>('[role="option"]')];

    expect(options.length).toBe(2);
    expect(input.getAttribute('aria-controls')).toBe(
      (root.querySelector('[role="listbox"]') as HTMLElement).id
    );
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0].id);
    expect(options.map(o => o.getAttribute('aria-selected'))).toEqual(['true', 'false']);

    keydown('ArrowDown');
    fixture.detectChanges();
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1].id);
    expect(options[1].getAttribute('aria-selected')).toBe('true');

    options[1].click();
    expect(component.line()).toBe('operations/purge ');
  });

  it('points the input at nothing while there is no suggestion', () => {
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    expect(input.hasAttribute('aria-controls')).toBe(false);
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('stops suggesting once the command is complete', () => {
    component.onInput('core/version');
    expect(component.suggestions()).toEqual([]);
    expect(component.activeCommand()?.Title).toBe('Shows the version');
  });

  it('accepts the selected suggestion on Tab', () => {
    component.onInput('oper');
    keydown('ArrowDown');
    const event = keydown('Tab');
    expect(event.defaultPrevented).toBe(true);
    expect(component.line()).toBe('operations/purge ');
  });

  it('suggests parameters and remotes for the typed command', () => {
    component.onInput('operations/list re');
    expect(component.suggestions().map(s => s.line)).toEqual(['operations/list remote=']);
    component.onInput('operations/list fs=d');
    expect(component.suggestions().map(s => s.line)).toEqual(['operations/list fs=dropbox:']);
  });

  it('offers the parameters that are not on the line yet as chips', () => {
    component.onInput('operations/list fs=gdrive:');
    expect(component.missingParams().map(p => p.name)).toEqual(['remote']);
    component.insertParam('remote');
    expect(component.line()).toBe('operations/list fs=gdrive: remote=');
  });

  it('runs a call and records the response', async () => {
    component.onInput('core/version');
    await component.run();

    expect(service.call).toHaveBeenCalledWith('core/version', {});
    expect(service.addToHistory).toHaveBeenCalledWith('core/version');
    const [entry] = component.entries();
    expect(entry.running).toBe(false);
    expect(entry.response?.ok).toBe(true);
    expect(entry.jobId).toBeUndefined();
    expect(component.line()).toBe('');
  });

  it('does not wait for a running call before running the next one', async () => {
    let finishFirst: (r: RcConsoleResponse) => void = () => undefined;
    service.call.mockReturnValueOnce(new Promise<RcConsoleResponse>(r => (finishFirst = r)));

    component.onInput('operations/size fs=slow:');
    const first = component.run();
    expect(component.entries()[0].running).toBe(true);

    component.onInput('core/version');
    await component.run();
    expect(service.call).toHaveBeenCalledTimes(2);
    expect(component.entries().map(e => e.running)).toEqual([true, false]);

    finishFirst(ok({ count: 1 }));
    await first;
    expect(component.entries().map(e => e.running)).toEqual([false, false]);
    expect(component.entries()[0].response?.body).toEqual({ count: 1 });
  });

  it('sends key=value parameters', async () => {
    component.onInput('operations/list fs=drive: opt.recurse=true');
    await component.run();
    expect(service.call).toHaveBeenCalledWith('operations/list', {
      fs: 'drive:',
      'opt.recurse': 'true',
    });
  });

  it('keeps a failed call as an entry with its status', async () => {
    service.call.mockResolvedValue({
      ok: false,
      status: 400,
      durationMs: 2,
      body: { error: 'bad fs' },
    });
    component.onInput('operations/list');
    await component.run();
    const [entry] = component.entries();
    expect(entry.response).toMatchObject({ ok: false, status: 400 });
  });

  it('follows the job of an _async call', async () => {
    service.call.mockResolvedValue(ok({ jobid: 7 }));
    component.onInput('operations/list fs=drive: _async=true');
    await component.run();
    expect(component.entries()[0].jobId).toBe(7);

    component.onInput('operations/list fs=drive:');
    await component.run();
    expect(component.entries()[1].jobId).toBeUndefined();
  });

  it('shows the error and keeps the line when it does not parse', async () => {
    component.onInput('operations/list fs');
    await component.run();
    expect(service.call).not.toHaveBeenCalled();
    expect(component.notice()?.key).toBe('modals.rcConsole.errors.missingEquals');
    expect(component.line()).toBe('operations/list fs');

    component.onInput('operations/list fs=a:');
    expect(component.notice()).toBeNull();
  });

  describe('read-only mode', () => {
    it('is on by default and blocks calls that write', async () => {
      component.onInput('sync/copy srcFs=a: dstFs=b:');
      await component.run();
      expect(service.call).not.toHaveBeenCalled();
      expect(component.notice()).toMatchObject({
        key: 'modals.rcConsole.readOnlyBlocked',
        params: { command: 'sync/copy' },
        allowWrites: true,
      });
    });

    it('lets the call through once writes are allowed', async () => {
      component.onInput('sync/copy srcFs=a: dstFs=b:');
      await component.run();
      component.allowWrites();
      expect(component.readOnly()).toBe(false);
      await component.run();
      expect(service.call).toHaveBeenCalledWith('sync/copy', { srcFs: 'a:', dstFs: 'b:' });
    });
  });

  describe('dangerous calls', () => {
    beforeEach(() => component.readOnly.set(false));

    it('ask for a second Enter', async () => {
      component.onInput('operations/purge fs=drive:tmp');
      await component.run();
      expect(service.call).not.toHaveBeenCalled();
      expect(component.confirmCommand()).toBe('operations/purge');

      await component.run();
      expect(service.call).toHaveBeenCalledWith('operations/purge', { fs: 'drive:tmp' });
    });

    it('are cancelled by Escape and by changing the line', async () => {
      component.onInput('core/quit');
      await component.run();
      expect(component.confirmCommand()).toBe('core/quit');

      const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      const stop = vi.spyOn(escape, 'stopPropagation');
      component.onKeydown(escape);
      expect(stop).toHaveBeenCalled();
      expect(component.confirmCommand()).toBeNull();

      await component.run();
      component.onInput('core/quit x=1');
      expect(component.confirmCommand()).toBeNull();
    });
  });

  it('lets Escape through when there is nothing to cancel', () => {
    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    const stop = vi.spyOn(escape, 'stopPropagation');
    component.onKeydown(escape);
    expect(stop).not.toHaveBeenCalled();
  });

  it('keeps Shift+Enter for a new line', () => {
    const event = keydown('Enter', { shiftKey: true });
    expect(event.defaultPrevented).toBe(false);
  });

  describe('help', () => {
    it('prints the syntax guide for a bare help', async () => {
      component.onInput('help');
      await component.run();
      expect(component.entries()[0].kind).toBe('guide');
      expect(service.call).not.toHaveBeenCalled();
    });

    it('opens the panel for help <command>', async () => {
      component.onInput('help operations/list');
      await component.run();
      expect(component.helpCommand()?.Path).toBe('operations/list');
      expect(component.entries()).toEqual([]);
    });

    it('opens the panel when a call is picked from the tree and follows the typed command', () => {
      component.pickCommand('operations/list');
      expect(component.line()).toBe('operations/list ');
      expect(component.helpCommand()?.Path).toBe('operations/list');

      component.onInput('core/version');
      expect(component.helpCommand()?.Path).toBe('core/version');
      component.closeHelp();
      expect(component.helpCommand()).toBeUndefined();
    });
  });

  it('clears the console with the clear command and Ctrl+L', async () => {
    component.onInput('core/version');
    await component.run();
    keydown('l', { ctrlKey: true });
    expect(component.entries()).toEqual([]);

    component.onInput('core/version');
    await component.run();
    component.onInput('clear');
    await component.run();
    expect(component.entries()).toEqual([]);
  });

  it('browses the history with the arrow keys and restores the draft', () => {
    service.history.set(['core/version', 'core/pid']);
    component.onInput('dra');

    keydown('ArrowUp');
    expect(component.line()).toBe('core/pid');
    keydown('ArrowUp');
    expect(component.line()).toBe('core/version');
    keydown('ArrowUp');
    expect(component.line()).toBe('core/version');

    keydown('ArrowDown');
    expect(component.line()).toBe('core/pid');
    keydown('ArrowDown');
    expect(component.line()).toBe('dra');
  });

  describe('secrets', () => {
    it('masks them in the echoed line but keeps the real one for editing', async () => {
      component.readOnly.set(false);
      component.onInput('config/create name=x pass=hunter2');
      await component.run(); // config/create asks for a second Enter
      await component.run();
      const [entry] = component.entries();
      expect(entry.line).toContain('hunter2');
      expect(entry.maskedLine).not.toContain('hunter2');
      expect(component.entryRcLine(entry)).not.toContain('hunter2');

      component.toggleMask();
      expect(component.entryRcLine(entry)).toContain('hunter2');
    });

    it('masks a secret that a pattern on the typed text would cut short', async () => {
      component.readOnly.set(false);
      component.onInput('config/create name=x password="a \\"b\\" c"');
      await component.run(); // config/create asks for a second Enter
      await component.run();
      const [entry] = component.entries();
      expect(entry.maskedLine).toBe('config/create name=x password=••••••');
    });

    it('tells the user when a line was not saved', () => {
      service.saveSnippet.mockReturnValue(false);
      component.onInput('config/create pass=x');
      component.saveCurrent();
      expect(component.notice()?.key).toBe('modals.rcConsole.snippetSecret');
    });
  });

  it('builds the rclone rc line to copy from the entry', async () => {
    component.onInput('operations/list fs=drive:');
    await component.run();
    const [entry] = component.entries();
    expect(component.entryRcLine(entry)).toBe('rclone rc operations/list fs=drive:');
  });

  it('lists the newest history first and fills the line from it', () => {
    service.history.set(['a/one', 'b/two']);
    expect(component.recent()).toEqual(['b/two', 'a/one']);
    component.toggleRecent();
    component.useRecent('a/one');
    expect(component.recentOpen()).toBe(false);
    expect(component.line()).toBe('a/one');
  });

  describe('Ctrl+F', () => {
    const ctrlF = (): KeyboardEvent =>
      new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, cancelable: true });

    it('opens a hidden sidebar and shows its search', () => {
      component.isSidebarOpen.set(false);
      const event = ctrlF();
      component.onWindowKeydown(event);

      expect(event.defaultPrevented).toBe(true);
      expect(component.isSidebarOpen()).toBe(true);
    });

    it('leaves the key to the search box while the sidebar is open', () => {
      component.isSidebarOpen.set(true);
      const event = ctrlF();
      component.onWindowKeydown(event);
      expect(event.defaultPrevented).toBe(false);
    });

    it('ignores other keys', () => {
      component.isSidebarOpen.set(false);
      component.onWindowKeydown(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true }));
      expect(component.isSidebarOpen()).toBe(false);
    });
  });

  describe('on a touch screen', () => {
    const lineBreak = (): InputEvent =>
      new InputEvent('beforeinput', { inputType: 'insertLineBreak', cancelable: true });

    it('runs the line when the keyboard announces a line break without an Enter keydown', async () => {
      component.onInput('core/version');
      const event = lineBreak();
      component.onBeforeInput(event);
      await fixture.whenStable();
      expect(event.defaultPrevented).toBe(true);
      expect(service.call).toHaveBeenCalledWith('core/version', {});
    });

    it('keeps the line break that Shift+Enter asked for', () => {
      component.onInput('core/version');
      keydown('Enter', { shiftKey: true });
      const event = lineBreak();
      component.onBeforeInput(event);
      expect(event.defaultPrevented).toBe(false);
      expect(service.call).not.toHaveBeenCalled();

      const second = lineBreak();
      component.onBeforeInput(second);
      expect(second.defaultPrevented).toBe(true);
    });

    it('ignores other kinds of input', () => {
      const event = new InputEvent('beforeinput', { inputType: 'insertText', cancelable: true });
      component.onBeforeInput(event);
      expect(event.defaultPrevented).toBe(false);
    });

    it('does not raise the keyboard by itself, but does when the user picks a call', async () => {
      const original = window.matchMedia;
      window.matchMedia = ((query: string) => ({
        matches: query === '(pointer: coarse)',
        media: query,
        addEventListener: (): void => undefined,
        removeEventListener: (): void => undefined,
      })) as unknown as typeof window.matchMedia;
      try {
        await configure();
        const field = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
        expect(document.activeElement).not.toBe(field);

        component.pickCommand('core/version');
        expect(document.activeElement).toBe(field);
      } finally {
        window.matchMedia = original;
      }
    });
  });
  describe('engine', () => {
    it('shows the version and process id of the running engine', () => {
      fixture.detectChanges();
      const text = (fixture.nativeElement as HTMLElement).querySelector('.engine')?.textContent;
      expect(text).toContain('v1.70.0');
      expect(text).toContain('4242');
    });

    it('needs a second click before it stops the process, and then stops that one', async () => {
      await component.restartEngine();
      expect(component.restartArmed()).toBe(true);
      expect(systemInfo.killProcess).not.toHaveBeenCalled();

      await component.restartEngine();
      expect(component.restartArmed()).toBe(false);
      expect(systemInfo.killProcess).toHaveBeenCalledWith(4242);
      expect(notifications.showInfo).toHaveBeenCalledTimes(1);
      expect(status.refreshStatus).toHaveBeenCalled();
      expect(component.restartingEngine()).toBe(false);
    });

    it('drops the first click when the second does not come', async () => {
      vi.useFakeTimers();
      try {
        await component.restartEngine();
        vi.advanceTimersByTime(5000);
        expect(component.restartArmed()).toBe(false);
        await component.restartEngine();
        expect(systemInfo.killProcess).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports a process that could not be stopped', async () => {
      systemInfo.killProcess.mockRejectedValueOnce(new Error('denied'));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await component.restartEngine();
      await component.restartEngine();
      expect(notifications.showError).toHaveBeenCalledTimes(1);
      expect(component.restartingEngine()).toBe(false);
    });

    it('does not try to stop a process it does not know', async () => {
      status.rclonePID.set(null);
      await component.restartEngine();
      await component.restartEngine();
      expect(systemInfo.killProcess).not.toHaveBeenCalled();
      expect(notifications.showInfo).toHaveBeenCalledTimes(1);
    });

    it('offers the restart only for a local desktop engine', async () => {
      expect(component.canRestartEngine()).toBe(true);

      backendName.set('Remote');
      expect(component.canRestartEngine()).toBe(false);

      backendName.set('Local');
      systemInfo.isLibrclone.mockResolvedValue(true);
      await configure();
      expect(component.canRestartEngine()).toBe(false);
    });

    it('reads the call list again when the engine comes back as a new process', async () => {
      service.loadCommands.mockClear();
      status.rclonePID.set(5555);
      fixture.detectChanges();
      await fixture.whenStable();
      expect(service.loadCommands).toHaveBeenCalledWith(true);

      // The first process id seen, and the same one again, change nothing.
      service.loadCommands.mockClear();
      status.rclonePID.set(null);
      status.rclonePID.set(5555);
      fixture.detectChanges();
      await fixture.whenStable();
      expect(service.loadCommands).not.toHaveBeenCalled();
    });

    it('keeps the list it had when the new engine does not answer yet', async () => {
      service.loadCommands.mockResolvedValue([]);
      status.rclonePID.set(5555);
      fixture.detectChanges();
      await fixture.whenStable();
      expect(component.commands().length).toBe(3);
      expect(component.loadState()).toBe('ready');
    });
  });
});
