import { NautilusService } from './nautilus.service';
import { FlowOverlayService } from './flow-overlay.service';
import { MainUiOverlayService } from './main-ui-overlay.service';
import { computed, signal, Signal, WritableSignal } from '@angular/core';
import { AppTab, MainView, Remote } from '@app/types';
import { AppNavigationService } from './app-navigation.service';
import { UiStateService } from './state/ui-state.service';
import { QuickRunService } from '../flow/quick-run.service';
import { WorkflowStateService } from '../flow/workflow-state.service';
import { WorkflowStorageService } from '../flow/workflow-storage.service';
import { RemoteFacadeService } from '../facade/remote-facade.service';
import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MainNavigation, NavigationHistoryService } from './navigation-history.service';

const home: MainNavigation = {
  view: 'main_menu',
  tab: 'general',
  remote: null,
  quickRun: null,
  flowMode: 'quick_run',
  workflow: null,
};

interface BrowserHarness {
  history: History;
  readonly location: URL;
  addEventListener: EventTarget['addEventListener'];
  removeEventListener: EventTarget['removeEventListener'];
  sessionStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

/** Browser history traversal is asynchronous, unlike pushState/replaceState. */
function browser(initialUrl = 'http://localhost/'): BrowserHarness {
  let index = 0;
  let requestedIndex = 0;
  let entries: { state: unknown; url: string }[] = [{ state: null, url: initialUrl }];
  const events = new EventTarget();
  const session = new Map<string, string>();
  const sessionStorage = {
    getItem: (key: string): string | null => session.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      session.set(key, value);
    },
    removeItem: (key: string): void => {
      session.delete(key);
    },
  };
  const go = (delta: number): void => {
    setTimeout(() => {
      requestedIndex += delta;
      const target = requestedIndex;
      if (target < 0 || target >= entries.length) {
        requestedIndex = index;
        return;
      }
      index = target;
      events.dispatchEvent(new PopStateEvent('popstate', { state: entries[index].state }));
    });
  };
  const history = {
    get state(): unknown {
      return structuredClone(entries[index].state);
    },
    pushState: vi.fn((state: unknown, _: string, url: string) => {
      entries = entries.slice(0, index + 1);
      entries.push({ state: structuredClone(state), url: new URL(url, entries[index].url).href });
      index++;
      requestedIndex = index;
    }),
    replaceState: vi.fn((state: unknown, _: string, url: string) => {
      entries[index] = {
        state: structuredClone(state),
        url: new URL(url, entries[index].url).href,
      };
      requestedIndex = index;
    }),
    go: vi.fn(go),
    back: vi.fn(() => go(-1)),
    forward: vi.fn(() => go(1)),
  } as unknown as History;
  return {
    history,
    sessionStorage,
    get location(): URL {
      return new URL(entries[index].url);
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  };
}

const settle = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
};

describe('NavigationHistoryService', () => {
  let win: ReturnType<typeof browser>;
  let service: NavigationHistoryService;
  function configure(url?: string): void {
    win = browser(url);
    TestBed.configureTestingModule({
      providers: [{ provide: DOCUMENT, useValue: { defaultView: win } }],
    });
    service = TestBed.inject(NavigationHistoryService);
  }
  beforeEach(() => {
    TestBed.resetTestingModule();
    configure();
  });

  it('groups synchronous screen, tab and selection changes into one entry', async () => {
    service.initialize(home);
    service.updateMain({ ...home, view: 'flow' });
    service.updateMain({ ...home, view: 'flow', quickRun: 'qr-1' });
    await settle();
    expect(win.history.pushState).toHaveBeenCalledTimes(1);
    const restore = vi.fn();
    service.restored$.subscribe(restore);
    service.back();
    await settle();
    expect(service.current()?.main).toEqual(home);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(win.history.pushState).toHaveBeenCalledTimes(1);
    service.forward();
    await settle();
    expect(service.current()?.main.quickRun).toBe('qr-1');
  });

  it('does not record duplicate state or restoration feedback', async () => {
    service.initialize(home);
    service.restored$.subscribe(entry => service.updateMain(entry.main));
    service.updateMain({ ...home });
    await settle();
    expect(win.history.pushState).not.toHaveBeenCalled();
  });

  it('discards the forward branch after new navigation', async () => {
    service.initialize(home);
    service.updateMain({ ...home, remote: 'A' });
    await settle();
    service.updateMain({ ...home, remote: 'B' });
    await settle();
    service.back();
    await settle();
    expect(service.canGoForward()).toBe(true);
    service.updateMain({ ...home, remote: 'C' });
    await settle();
    expect(service.canGoForward()).toBe(false);
    service.back();
    await settle();
    expect(service.current()?.main.remote).toBe('A');
  });

  it('restores Nautilus root, panel identity and index without adding entries', async () => {
    service.initialize({ ...home, view: 'nautilus' });
    const root = { tab: 1, pane: 0 as const, remote: null, path: '' };
    service.updateNautilus(root, true);
    service.updateNautilus({ ...root, remote: 'drive', path: 'a/#?/文件' });
    await settle();
    expect(win.location.pathname).toBe('/nautilus/drive/a/%23%3F/%E6%96%87%E4%BB%B6');
    service.updateNautilus({ ...root, tab: 2, pane: 1, remote: '/', path: 'tmp' });
    await settle();
    service.back();
    await settle();
    expect(service.current()?.nautilus?.tab).toBe(1);
    service.back();
    await settle();
    expect(service.current()?.nautilus).toEqual(root);
    expect(win.location.pathname).toBe('/nautilus');
    expect(win.history.pushState).toHaveBeenCalledTimes(2);
  });

  it('closes only the top layer on Back and consumes manual closes', async () => {
    service.initialize(home);
    const first = vi.fn();
    const second = vi.fn();
    const releaseFirst = service.openLayer(first);
    service.openLayer(second);
    service.back();
    await settle();
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    releaseFirst();
    await settle();
    expect(service.current()?.index).toBe(0);
    expect(service.canGoBack()).toBe(false);
  });

  it('closes all departed layers in reverse order on multi-entry traversal', async () => {
    service.initialize(home);
    const order: number[] = [];
    service.openLayer(() => order.push(1));
    service.openLayer(() => order.push(2));
    // Two queued traversals model repeated hardware Back presses.
    win.history.back();
    win.history.back();
    await settle();
    expect(order).toEqual([2, 1]);
  });

  it('preserves navigation triggered by a dialog result during close', async () => {
    service.initialize(home);
    const release = service.openLayer(vi.fn());
    release();
    service.updateMain({ ...home, view: 'flow', quickRun: 'result' });
    await settle();
    expect(service.current()?.main.quickRun).toBe('result');
    service.back();
    await settle();
    expect(service.current()?.main).toEqual(home);
  });

  it('explicit overlay close consumes all navigation entries inside that overlay', async () => {
    service.initialize(home);
    const release = service.openLayer(vi.fn());
    service.updateMain({ ...home, remote: 'one' });
    await settle();
    service.updateMain({ ...home, remote: 'two' });
    await settle();
    release();
    await settle();
    expect(service.current()?.main).toEqual(home);
    expect(service.canGoBack()).toBe(false);
  });

  it('keeps a covering dialog open when its underlying sidebar closes', async () => {
    service.initialize(home);
    const releaseSidebar = service.openLayer(vi.fn());
    const closeDialog = vi.fn();
    const releaseDialog = service.openLayer(closeDialog);
    releaseSidebar();
    await settle();
    expect(closeDialog).not.toHaveBeenCalled();
    expect(win.history.go).not.toHaveBeenCalled();
    releaseDialog();
    await settle();
    expect(service.current()?.index).toBe(0);
  });

  it('serializes simultaneous nested closes without traversing beyond their parent', async () => {
    service.initialize(home);
    service.updateMain({ ...home, tab: 'operations' });
    await settle();
    const releaseOuter = service.openLayer(vi.fn());
    const releaseInner = service.openLayer(vi.fn());
    releaseInner();
    releaseOuter();
    await settle();
    expect(service.current()?.index).toBe(1);
    expect(service.current()?.main.tab).toBe('operations');
  });

  it('preserves only changed state when a closing overlay navigates', async () => {
    service.initialize(home);
    const root = { tab: 1, pane: 0 as const, remote: null, path: '' };
    service.updateNautilus(root, true);
    const release = service.openLayer(vi.fn());
    service.updateNautilus({ ...root, remote: 'drive', path: 'temporary' });
    await settle();
    release();
    service.updateMain({ ...home, view: 'flow', quickRun: 'result' });
    await settle();
    expect(service.current()?.main.quickRun).toBe('result');
    expect(service.current()?.nautilus).toEqual(root);
  });

  it('registers a replacement dialog after the previous close traversal', async () => {
    service.initialize(home);
    const release = service.openLayer(vi.fn());
    release();
    const closeReplacement = vi.fn();
    service.openLayer(closeReplacement);
    await settle();
    expect(closeReplacement).not.toHaveBeenCalled();
    expect(service.current()?.index).toBe(1);
    service.back();
    await settle();
    expect(closeReplacement).toHaveBeenCalledOnce();
    expect(service.current()?.index).toBe(0);
  });

  it('does not register a replacement that closes before traversal finishes', async () => {
    service.initialize(home);
    service.openLayer(vi.fn())();
    const release = service.openLayer(vi.fn());
    release();
    await settle();
    expect(service.current()?.index).toBe(0);
    expect(win.history.pushState).toHaveBeenCalledTimes(1);
  });

  it('does not reopen a resolved picker on Forward', async () => {
    service.initialize(home);
    const close = vi.fn();
    service.openLayer(close);
    service.back();
    await settle();
    service.forward();
    await settle();
    expect(service.current()?.index).toBe(1);
    expect(close).toHaveBeenCalledOnce();
  });

  it('restores the current entry after reload and still handles older Back entries', async () => {
    service.initialize(home);
    service.updateMain({ ...home, view: 'flow', quickRun: 'qr-1' });
    await settle();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: DOCUMENT, useValue: { defaultView: win } }],
    });
    service = TestBed.inject(NavigationHistoryService);
    service.initialize(home);
    expect(service.current()?.main.quickRun).toBe('qr-1');
    service.back();
    await settle();
    expect(service.current()?.main).toEqual(home);
  });

  it('retains Forward availability when the page reloads on an older entry', async () => {
    service.initialize(home);
    service.updateMain({ ...home, remote: 'A' });
    await settle();
    service.updateMain({ ...home, remote: 'B' });
    await settle();
    service.back();
    await settle();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: DOCUMENT, useValue: { defaultView: win } }],
    });
    service = TestBed.inject(NavigationHistoryService);
    service.initialize(home);
    expect(service.current()?.main.remote).toBe('A');
    expect(service.canGoForward()).toBe(true);
    service.forward();
    await settle();
    expect(service.current()?.main.remote).toBe('B');
  });

  it('parses deep links, preserves unrelated query parameters and separates window mode', async () => {
    TestBed.resetTestingModule();
    configure('http://localhost/workflows/a%26b?token=keep');
    service.initialize(home);
    expect(service.current()?.main).toMatchObject({
      view: 'flow',
      workflow: 'a&b',
      flowMode: 'builder',
    });
    service.updateMain({ ...home, view: 'nautilus' });
    await settle();
    expect(win.location.searchParams.get('token')).toBe('keep');
    expect(win.location.searchParams.has('standalone')).toBe(false);
  });

  it('keeps inactive workspace changes out of visible history', async () => {
    service.initialize(home);
    service.updateMain({ ...home, quickRun: 'background' });
    await settle();
    expect(win.location.pathname).toBe('/main');
    expect(win.history.pushState).not.toHaveBeenCalled();
    service.updateMain({ ...home, view: 'flow', quickRun: 'background' });
    await settle();
    expect(win.location.pathname).toBe('/quickrun/background');
    service.back();
    await settle();
    expect(win.location.pathname).toBe('/main');
    expect(service.current()?.main.view).toBe('main_menu');
  });

  it('restores a copied Nautilus deep link in a new session', () => {
    TestBed.resetTestingModule();
    configure('http://localhost/nautilus/Google%20Drive/Documents');
    service.initialize(home);
    expect(service.current()?.main.view).toBe('nautilus');
    expect(service.current()?.nautilus).toMatchObject({
      remote: 'Google Drive',
      path: 'Documents',
    });
    expect(win.location.search).toBe('');
  });

  it('ignores malformed saved state and invalid URL enum values', () => {
    win.history.replaceState(
      { rcloneNavigation: { session: 'bad', main: null } },
      '',
      '/?view=bad&tab=bad&mode=bad'
    );
    service.initialize(home);
    expect(service.current()?.main).toEqual(home);
  });
  it('synchronizes workspace signals, URL and native browser Back/Forward', async () => {
    TestBed.resetTestingModule();
    win = browser();
    const view = signal<MainView>('main_menu');
    const nautilusOpen = signal(false);
    const flowOpen = signal(false);
    const active = computed(() => (nautilusOpen() ? 'nautilus' : flowOpen() ? 'flow' : view()));
    const remote = signal<Remote | null>({ name: 'Google Drive' } as Remote);
    const tab = signal<AppTab>('general');
    const quickRun = signal<string | null>(null);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: NautilusService,
          useValue: {
            closeBrowserOverlay: (): void => nautilusOpen.set(false),
            openBrowserOverlay: async (): Promise<void> => nautilusOpen.set(true),
          },
        },
        {
          provide: FlowOverlayService,
          useValue: {
            closeFlowOverlay: (): void => flowOpen.set(false),
            openFlowOverlay: async (): Promise<void> => flowOpen.set(true),
          },
        },
        { provide: MainUiOverlayService, useValue: { closeMainUiOverlay: vi.fn() } },
        { provide: DOCUMENT, useValue: { defaultView: win } },
        {
          provide: UiStateService,
          useValue: {
            selectedMainView: view,
            activeWorkspace: active,
            setMainView: view.set,
            selectedRemote: remote,
            setSelectedRemote: remote.set,
            currentTab: tab,
            setTab: tab.set,
            flowSubMode: signal('quick_run'),
            setFlowSubMode: vi.fn(),
          },
        },
        { provide: QuickRunService, useValue: { selectedId: quickRun, select: quickRun.set } },
        { provide: RemoteFacadeService, useValue: { activeRemotes: signal([remote()]) } },
        {
          provide: WorkflowStateService,
          useValue: { currentWorkflow: signal(null), loadWorkflow: vi.fn() },
        },
        { provide: WorkflowStorageService, useValue: { workflows: signal([]) } },
      ],
    });
    service = TestBed.inject(NavigationHistoryService);
    const navigation = TestBed.inject(AppNavigationService);
    navigation.initialize(null);
    TestBed.tick();
    await settle();
    expect(win.location.pathname).toBe('/main/Google%20Drive');
    expect(service.canGoBack()).toBe(false);
    nautilusOpen.set(true);
    TestBed.tick();
    await settle();
    service.updateNautilus({ tab: 1, pane: 0, remote: 'Google Drive', path: 'Documents' });
    await settle();
    expect(win.location.pathname).toBe('/nautilus/Google%20Drive/Documents');
    flowOpen.set(true);
    nautilusOpen.set(false);
    quickRun.set('qr-1');
    TestBed.tick();
    await settle();
    expect(win.location.pathname).toBe('/quickrun/qr-1');
    expect(win.location.search).toBe('');
    expect(service.canGoBack()).toBe(true);
    win.history.back();
    await settle();
    TestBed.tick();
    await settle();
    expect(active()).toBe('nautilus');
    expect(nautilusOpen()).toBe(true);
    expect(win.location.pathname).toBe('/nautilus/Google%20Drive/Documents');
    win.history.forward();
    await settle();
    TestBed.tick();
    await settle();
    expect(active()).toBe('flow');
    expect(flowOpen()).toBe(true);
    expect(quickRun()).toBe('qr-1');
    expect(win.location.pathname).toBe('/quickrun/qr-1');
  });
});

describe('Workspace restoration on startup', () => {
  function configureWorkspace(
    win: BrowserHarness,
    base: MainView
  ): {
    history: NavigationHistoryService;
    navigation: AppNavigationService;
    view: WritableSignal<MainView>;
    active: Signal<MainView>;
    nautilusOpen: WritableSignal<boolean>;
    flowOpen: WritableSignal<boolean>;
    mainOpen: WritableSignal<boolean>;
    quickRun: WritableSignal<string | null>;
  } {
    const view = signal<MainView>(base);
    const nautilusOpen = signal(false);
    const flowOpen = signal(false);
    const mainOpen = signal(false);
    const active = computed(() =>
      nautilusOpen() ? 'nautilus' : flowOpen() ? 'flow' : mainOpen() ? 'main_menu' : view()
    );
    const remote = signal<Remote | null>(null);
    const tab = signal<AppTab>('general');
    const quickRun = signal<string | null>(null);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: NautilusService,
          useValue: {
            closeBrowserOverlay: (): void => nautilusOpen.set(false),
            openBrowserOverlay: async (): Promise<void> => nautilusOpen.set(true),
          },
        },
        {
          provide: FlowOverlayService,
          useValue: {
            closeFlowOverlay: (): void => flowOpen.set(false),
            openFlowOverlay: async (): Promise<void> => flowOpen.set(true),
          },
        },
        {
          provide: MainUiOverlayService,
          useValue: {
            closeMainUiOverlay: (): void => mainOpen.set(false),
            openMainUiOverlay: async (): Promise<void> => mainOpen.set(true),
          },
        },
        { provide: DOCUMENT, useValue: { defaultView: win } },
        {
          provide: UiStateService,
          useValue: {
            selectedMainView: view,
            activeWorkspace: active,
            setMainView: view.set,
            selectedRemote: remote,
            setSelectedRemote: remote.set,
            currentTab: tab,
            setTab: tab.set,
            flowSubMode: signal('quick_run'),
            setFlowSubMode: vi.fn(),
          },
        },
        { provide: QuickRunService, useValue: { selectedId: quickRun, select: quickRun.set } },
        { provide: RemoteFacadeService, useValue: { activeRemotes: signal<Remote[]>([]) } },
        {
          provide: WorkflowStateService,
          useValue: { currentWorkflow: signal(null), loadWorkflow: vi.fn() },
        },
        { provide: WorkflowStorageService, useValue: { workflows: signal([]) } },
      ],
    });
    const history = TestBed.inject(NavigationHistoryService);
    const navigation = TestBed.inject(AppNavigationService);

    return { history, navigation, view, active, nautilusOpen, flowOpen, mainOpen, quickRun };
  }

  beforeEach(() => TestBed.resetTestingModule());

  const cases: { base: MainView; target: MainView; path: string }[] = [
    { base: 'main_menu', target: 'flow', path: '/quickrun/qr-1' },
    { base: 'main_menu', target: 'nautilus', path: '/nautilus/Google%20Drive/Documents' },
    { base: 'flow', target: 'main_menu', path: '/main' },
    { base: 'nautilus', target: 'flow', path: '/quickrun/qr-1' },
    { base: 'flow', target: 'flow', path: '/quickrun/qr-1' },
    { base: 'nautilus', target: 'nautilus', path: '/nautilus/Google%20Drive/Documents' },
  ];

  for (const reload of [false, true]) {
    it.each(cases)(
      `${reload ? 'reloads' : 'opens a deep link to'} $path over the $base default`,
      async ({ base, target, path }) => {
        const win = browser(`http://localhost${path}`);
        if (reload) {
          const previous = configureWorkspace(win, base);
          previous.navigation.initialize(null);
          await settle();
          TestBed.tick();
          await settle();
          TestBed.resetTestingModule();
        }
        const state = configureWorkspace(win, base);
        const pushes = vi.mocked(win.history.pushState).mock.calls.length;
        state.navigation.initialize(null);
        TestBed.tick();
        await settle();
        TestBed.tick();
        await settle();
        expect(state.view()).toBe(base);
        expect(state.active()).toBe(target);
        expect(state.nautilusOpen()).toBe(target === 'nautilus' && base !== target);
        expect(state.flowOpen()).toBe(target === 'flow' && base !== target);
        expect(state.mainOpen()).toBe(target === 'main_menu' && base !== target);
        expect(win.location.pathname).toBe(path);
        expect(vi.mocked(win.history.pushState).mock.calls.length).toBe(pushes);
        if (target === 'flow') expect(state.quickRun()).toBe('qr-1');
        if (target === 'nautilus') {
          expect(state.history.current()?.nautilus).toMatchObject({
            remote: 'Google Drive',
            path: 'Documents',
          });
        }
        if (base !== target) {
          state.nautilusOpen.set(false);
          state.flowOpen.set(false);
          state.mainOpen.set(false);
          TestBed.tick();
          await settle();
          expect(state.active()).toBe(base);
          expect(state.history.current()?.main.view).toBe(base);
        }
      }
    );
  }

  it.each(cases.filter(({ base, target }) => base !== target))(
    'keeps standalone $target windows as their own base UI',
    async ({ target, path }) => {
      const win = browser(`http://localhost${path}`);
      const state = configureWorkspace(win, 'main_menu');
      state.navigation.initialize(target);
      await settle();
      TestBed.tick();
      await settle();
      expect(state.view()).toBe(target);
      expect(state.active()).toBe(target);
      expect(state.nautilusOpen()).toBe(false);
      expect(state.flowOpen()).toBe(false);
      expect(state.mainOpen()).toBe(false);
      expect(win.location.pathname).toBe(path);
    }
  );
});
