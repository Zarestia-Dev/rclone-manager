import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideTranslateService } from '@ngx-translate/core';

import { FlowContainerComponent } from './flow-container.component';
import { FlowSubMode } from '@app/types';
import { QuickRunService } from '../services/flow/quick-run.service';
import { WorkflowStateService } from '../services/flow/workflow-state.service';
import { UiStateService } from '../services/ui/state/ui-state.service';
import { LocalStorageService } from '../services/ui/state/local-storage.service';
import { ModalService } from '../services/ui/modal.service';

describe('FlowContainerComponent', () => {
  let fixture: ComponentFixture<FlowContainerComponent>;
  let component: FlowContainerComponent;

  let storageMap: Map<string, unknown>;
  let mockLocalStorage: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
  };

  let isWorkspaceDrawerOpenSignal = signal<boolean>(false);
  let isMobileFocusModeSignal = signal<boolean>(false);
  let mockWorkflowState: {
    isWorkspaceDrawerOpen: typeof isWorkspaceDrawerOpenSignal;
    isMobileFocusMode: typeof isMobileFocusModeSignal;
    createNewWorkflow: ReturnType<typeof vi.fn>;
    resetMobileUiState: ReturnType<typeof vi.fn>;
  };

  let mockQuickRunService: {
    selected: ReturnType<typeof vi.fn>;
    deselect: ReturnType<typeof vi.fn>;
    openEditor: ReturnType<typeof vi.fn>;
  };

  const flowSubMode = signal<FlowSubMode>('quick_run');

  let mockUiStateService: {
    flowSubMode: typeof flowSubMode;
    setFlowSubMode: ReturnType<typeof vi.fn>;
    selectedRemote: ReturnType<typeof vi.fn>;
    resetSelectedRemote: ReturnType<typeof vi.fn>;
    endLayoutEdit: ReturnType<typeof vi.fn>;
    registerMobileSidebar: ReturnType<typeof vi.fn>;
    unregisterMobileSidebar: ReturnType<typeof vi.fn>;
  };

  let mockModalService: {
    openRemoteConfig: ReturnType<typeof vi.fn>;
  };

  const createComponent = async (): Promise<void> => {
    await TestBed.configureTestingModule({
      imports: [FlowContainerComponent],
      providers: [
        provideTranslateService(),
        { provide: LocalStorageService, useValue: mockLocalStorage },
        { provide: WorkflowStateService, useValue: mockWorkflowState },
        { provide: QuickRunService, useValue: mockQuickRunService },
        { provide: UiStateService, useValue: mockUiStateService },
        { provide: ModalService, useValue: mockModalService },
      ],
    })
      .overrideComponent(FlowContainerComponent, {
        set: {
          template: '',
          imports: [],
        },
      })
      .compileComponents();

    fixture = TestBed.createComponent(FlowContainerComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  };

  beforeEach(() => {
    TestBed.resetTestingModule();
    storageMap = new Map<string, unknown>();

    mockLocalStorage = {
      get: vi.fn((key: string, fallback: unknown) =>
        storageMap.has(key) ? storageMap.get(key) : fallback
      ),
      set: vi.fn((key: string, val: unknown) => {
        storageMap.set(key, val);
      }),
    };

    isWorkspaceDrawerOpenSignal = signal<boolean>(false);
    isMobileFocusModeSignal = signal<boolean>(false);
    mockWorkflowState = {
      isWorkspaceDrawerOpen: isWorkspaceDrawerOpenSignal,
      isMobileFocusMode: isMobileFocusModeSignal,
      createNewWorkflow: vi.fn(),
      resetMobileUiState: vi.fn(),
    };

    mockQuickRunService = {
      selected: vi.fn().mockReturnValue(null),
      deselect: vi.fn(),
      openEditor: vi.fn(),
    };

    flowSubMode.set('quick_run');
    mockUiStateService = {
      flowSubMode,
      setFlowSubMode: vi.fn((mode: FlowSubMode) => {
        flowSubMode.set(mode);
      }),
      selectedRemote: vi.fn().mockReturnValue(null),
      resetSelectedRemote: vi.fn(),
      endLayoutEdit: vi.fn(),
      registerMobileSidebar: vi.fn(),
      unregisterMobileSidebar: vi.fn(),
    };

    mockModalService = {
      openRemoteConfig: vi.fn(),
    };
  });

  it('uses the shared sub-mode when recreated', async () => {
    flowSubMode.set('builder');
    await createComponent();

    expect(component.activeSubMode()).toBe('builder');
  });

  it('uses the shared default sub-mode', async () => {
    await createComponent();

    expect(component.activeSubMode()).toBe('quick_run');
  });

  it('should save to localStorage and end layout edit when setSubMode is called', async () => {
    await createComponent();

    component.setSubMode('builder');
    expect(component.activeSubMode()).toBe('builder');
    expect(mockUiStateService.endLayoutEdit).toHaveBeenCalled();
    expect(mockUiStateService.setFlowSubMode).toHaveBeenCalledWith('builder');

    component.setSubMode('quick_run');
    expect(component.activeSubMode()).toBe('quick_run');
    expect(mockUiStateService.setFlowSubMode).toHaveBeenCalledWith('quick_run');
  });

  it('reflects external navigation through the shared sub-mode', async () => {
    await createComponent();

    flowSubMode.set('builder');
    fixture.detectChanges();

    expect(component.activeSubMode()).toBe('builder');
  });

  it('should toggle and save sidebar state to localStorage', async () => {
    await createComponent();

    component.setSidebarOpen(false);
    expect(component.isSidebarOpen()).toBe(false);
    expect(mockLocalStorage.set).toHaveBeenCalledWith('ui.flowSidebarOpen', false);

    component.setSidebarOpen(true);
    expect(component.isSidebarOpen()).toBe(true);
    expect(mockLocalStorage.set).toHaveBeenCalledWith('ui.flowSidebarOpen', true);
  });

  it('should close sidebar in over mode when actions are triggered', async () => {
    await createComponent();

    component.sidebarMode.set('over');
    component.setSidebarOpen(true);

    component.onItemSelected();
    expect(component.isSidebarOpen()).toBe(false);

    component.setSidebarOpen(true);
    component.newWorkflow();
    expect(mockWorkflowState.createNewWorkflow).toHaveBeenCalled();
    expect(component.isSidebarOpen()).toBe(false);

    component.setSidebarOpen(true);
    component.newQuickRun();
    expect(mockQuickRunService.openEditor).toHaveBeenCalled();
    expect(component.isSidebarOpen()).toBe(false);

    component.setSidebarOpen(true);
    component.newRemote();
    expect(mockModalService.openRemoteConfig).toHaveBeenCalledWith({ editTarget: 'remote' });
    expect(component.isSidebarOpen()).toBe(false);
  });

  it('should not close sidebar in side mode when actions are triggered', async () => {
    await createComponent();

    component.sidebarMode.set('side');
    component.setSidebarOpen(true);

    component.onItemSelected();
    expect(component.isSidebarOpen()).toBe(true);
  });

  it('should reset selections when goHome is called', async () => {
    await createComponent();

    component.goHome();

    expect(mockQuickRunService.deselect).toHaveBeenCalled();
    expect(mockUiStateService.resetSelectedRemote).toHaveBeenCalled();
  });

  it('should update activeSubMode on quick run or workflow selected', async () => {
    await createComponent();

    component.onWorkflowSelected();
    expect(component.activeSubMode()).toBe('builder');

    component.onQuickRunSelected();
    expect(component.activeSubMode()).toBe('quick_run');
  });

  it('should compute isMobileTabsHidden correctly based on sidebar, drawer, and focus mode', async () => {
    await createComponent();

    // Default: side mode, builder mode, drawers closed
    component.sidebarMode.set('side');
    component.setSubMode('builder');
    isWorkspaceDrawerOpenSignal.set(false);
    isMobileFocusModeSignal.set(false);
    expect(component.isMobileTabsHidden()).toBe(false);

    // 1. Flow sidebar in over mode and open
    component.sidebarMode.set('over');
    component.setSidebarOpen(true);
    expect(component.isMobileTabsHidden()).toBe(true);

    // Close flow sidebar
    component.setSidebarOpen(false);
    expect(component.isMobileTabsHidden()).toBe(false);

    // 2. Workflow workspace drawer open in builder mode
    isWorkspaceDrawerOpenSignal.set(true);
    expect(component.isMobileTabsHidden()).toBe(true);

    // Switch to quick_run: builder drawer does not hide quick_run tabs
    component.setSubMode('quick_run');
    expect(component.isMobileTabsHidden()).toBe(false);
    expect(mockWorkflowState.resetMobileUiState).toHaveBeenCalled();

    // 3. Focus mode in builder
    component.setSubMode('builder');
    isWorkspaceDrawerOpenSignal.set(false);
    isMobileFocusModeSignal.set(true);
    expect(component.isMobileTabsHidden()).toBe(true);
  });
});
