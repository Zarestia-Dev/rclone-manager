import { NautilusService } from './nautilus.service';
import { FlowOverlayService } from './flow-overlay.service';
import { MainUiOverlayService } from './main-ui-overlay.service';
import { WorkflowStateService } from '../flow/workflow-state.service';
import { WorkflowStorageService } from '../flow/workflow-storage.service';
import { WorkflowDefinition } from '../../flow/workflow/types/workflow.types';
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
  const workflows = signal<WorkflowDefinition[]>([]);
  const currentWorkflow = signal<WorkflowDefinition | null>(null);
  const loadWorkflow = vi.fn((workflow: WorkflowDefinition) => currentWorkflow.set(workflow));
  const chosen: WorkflowDefinition = {
    id: 'chosen',
    name: 'Chosen',
    showOnTray: false,
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };

  beforeEach(() => {
    TestBed.resetTestingModule();
    view.set('main_menu');
    tab.set('general');
    mode.set('quick_run');
    remote.set(null);
    quickRun.set(null);
    remotes.set([]);
    updateMain.mockClear();
    workflows.set([]);
    currentWorkflow.set(null);
    loadWorkflow.mockClear();
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
          useValue: { currentWorkflow, loadWorkflow },
        },
        { provide: WorkflowStorageService, useValue: { workflows } },
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
  it('a user workflow selection supersedes an unresolved deep link', async () => {
    service.initialize(null);
    restored.next({ main: { ...home, view: 'flow', flowMode: 'builder', workflow: 'missing' } });
    await Promise.resolve();
    TestBed.tick();
    const state = TestBed.inject(WorkflowStateService);
    state.currentWorkflow.set(chosen);
    workflows.set([{ ...chosen, id: 'missing' }]);
    TestBed.tick();
    expect(updateMain).toHaveBeenLastCalledWith(expect.objectContaining({ workflow: 'chosen' }));
    expect(loadWorkflow).not.toHaveBeenCalled();
    expect(currentWorkflow()).toBe(chosen);
    currentWorkflow.set(null);
    TestBed.tick();
    expect(loadWorkflow).not.toHaveBeenCalled();
    expect(updateMain).toHaveBeenLastCalledWith(expect.objectContaining({ workflow: null }));
  });
  it('waits for a deep-linked workflow after clearing the previous selection', async () => {
    service.initialize(null);
    currentWorkflow.set(chosen);
    restored.next({ main: { ...home, view: 'flow', flowMode: 'builder', workflow: 'late' } });
    await Promise.resolve();
    TestBed.tick();
    expect(currentWorkflow()).toBeNull();
    expect(updateMain).toHaveBeenLastCalledWith(expect.objectContaining({ workflow: 'late' }));
    const late = { ...chosen, id: 'late' };
    workflows.set([late]);
    TestBed.tick();
    expect(loadWorkflow).toHaveBeenCalledExactlyOnceWith(late);
    expect(currentWorkflow()).toBe(late);
  });

  it('cancels a pending workflow when history restores an empty selection', async () => {
    service.initialize(null);
    restored.next({ main: { ...home, view: 'flow', workflow: 'late' } });
    await Promise.resolve();
    TestBed.tick();
    restored.next({ main: home });
    await Promise.resolve();
    workflows.set([{ ...chosen, id: 'late' }]);
    TestBed.tick();
    expect(loadWorkflow).not.toHaveBeenCalled();
    expect(currentWorkflow()).toBeNull();
    expect(updateMain).toHaveBeenLastCalledWith(home);
  });
});
