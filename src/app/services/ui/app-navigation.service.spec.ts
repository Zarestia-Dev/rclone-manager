import { NautilusService } from './nautilus.service';
import { FlowOverlayService } from './flow-overlay.service';
import { MainUiOverlayService } from './main-ui-overlay.service';
import { WorkflowStateService } from '../flow/workflow-state.service';
import { WorkflowStorageService } from '../flow/workflow-storage.service';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppTab, FlowSubMode, MainView, Remote } from '@app/types';
import { AppNavigationService } from './app-navigation.service';
import { MainNavigation, NavigationHistoryService } from './navigation-history.service';
import { UiStateService } from './state/ui-state.service';
import { QuickRunService } from '../flow/quick-run.service';
import { RemoteFacadeService } from '../facade/remote-facade.service';

const home: MainNavigation = {
  view: 'main_menu',
  tab: 'general',
  remote: null,
  quickRun: null,
  flowMode: 'quick_run',
  workflow: null,
};

describe('AppNavigationService', () => {
  const view = signal<MainView>('main_menu');
  const tab = signal<AppTab>('general');
  const mode = signal<FlowSubMode>('quick_run');
  const remote = signal<Remote | null>(null);
  const quickRun = signal<string | null>(null);
  const remotes = signal<Remote[]>([]);
  let restored: Subject<{ main: MainNavigation }>;
  let service: AppNavigationService;
  const updateMain = vi.fn();

  beforeEach(() => {
    TestBed.resetTestingModule();
    view.set('main_menu');
    tab.set('general');
    mode.set('quick_run');
    remote.set(null);
    quickRun.set(null);
    remotes.set([]);
    updateMain.mockClear();
    restored = new Subject();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: NautilusService,
          useValue: {
            closeBrowserOverlay: vi.fn(),
            openBrowserOverlay: vi.fn(() => view.set('nautilus')),
          },
        },
        {
          provide: FlowOverlayService,
          useValue: { closeFlowOverlay: vi.fn(), openFlowOverlay: vi.fn(() => view.set('flow')) },
        },
        {
          provide: MainUiOverlayService,
          useValue: {
            closeMainUiOverlay: vi.fn(),
            openMainUiOverlay: vi.fn(() => view.set('main_menu')),
          },
        },
        {
          provide: WorkflowStateService,
          useValue: { currentWorkflow: signal(null), loadWorkflow: vi.fn() },
        },
        { provide: WorkflowStorageService, useValue: { workflows: signal([]) } },
        {
          provide: NavigationHistoryService,
          useValue: { restored$: restored, updateMain, initialize: vi.fn() },
        },
        {
          provide: UiStateService,
          useValue: {
            selectedMainView: view,
            activeWorkspace: view,
            currentTab: tab,
            selectedRemote: remote,
            flowSubMode: mode,
            setMainView: view.set,
            setTab: tab.set,
            setSelectedRemote: remote.set,
            setFlowSubMode: mode.set,
          },
        },
        { provide: QuickRunService, useValue: { selectedId: quickRun, select: quickRun.set } },
        { provide: RemoteFacadeService, useValue: { activeRemotes: remotes } },
      ],
    });
    service = TestBed.inject(AppNavigationService);
  });

  it('waits for initialization and captures a compound navigation as a single snapshot', () => {
    TestBed.tick();
    expect(updateMain).not.toHaveBeenCalled();
    service.initialize(null);
    TestBed.tick();
    updateMain.mockClear();
    view.set('flow');
    quickRun.set('qr-1');
    mode.set('quick_run');
    TestBed.tick();
    expect(updateMain).toHaveBeenCalledExactlyOnceWith({ ...home, view: 'flow', quickRun: 'qr-1' });
  });

  it('restores Main UI remote and tab, Quickrun selection, and Flow sub-mode', () => {
    const selected = { name: 'drive' } as Remote;
    remotes.set([selected]);
    service.initialize(null);
    restored.next({
      main: {
        ...home,
        view: 'flow',
        tab: 'operations',
        remote: 'drive',
        quickRun: 'qr-1',
        flowMode: 'builder',
      },
    });
    expect(view()).toBe('flow');
    expect(tab()).toBe('operations');
    expect(remote()).toBe(selected);
    expect(quickRun()).toBe('qr-1');
    expect(mode()).toBe('builder');
    restored.next({ main: home });
    expect(remote()).toBeNull();
    expect(quickRun()).toBeNull();
  });

  it('resolves a deep-linked remote when data arrives without losing its name', () => {
    service.initialize(null);
    restored.next({ main: { ...home, remote: 'late' } });
    TestBed.tick();
    expect(updateMain).toHaveBeenLastCalledWith({ ...home, remote: 'late' });
    const selected = { name: 'late' } as Remote;
    remotes.set([selected]);
    TestBed.tick();
    expect(remote()).toBe(selected);
    expect(updateMain).toHaveBeenLastCalledWith({ ...home, remote: 'late' });
  });
  it('does not let a delayed deep link overwrite a newer remote selection', () => {
    service.initialize(null);
    restored.next({ main: { ...home, remote: 'late' } });
    TestBed.tick();
    const selected = { name: 'chosen' } as Remote;
    remote.set(selected);
    remotes.set([selected, { name: 'late' } as Remote]);
    TestBed.tick();
    expect(remote()).toBe(selected);
    remote.set(null);
    TestBed.tick();
    expect(remote()).toBeNull();
    expect(updateMain).toHaveBeenLastCalledWith(home);
  });
});
