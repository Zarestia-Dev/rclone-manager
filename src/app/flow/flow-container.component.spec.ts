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

  let requestedSubModeSignal = signal<FlowSubMode | null>(null);
  let mockWorkflowState: {
    requestedSubMode: typeof requestedSubModeSignal;
    createNewWorkflow: ReturnType<typeof vi.fn>;
  };

  let mockQuickRunService: {
    selected: ReturnType<typeof vi.fn>;
    deselect: ReturnType<typeof vi.fn>;
    openEditor: ReturnType<typeof vi.fn>;
  };

  let mockUiStateService: {
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

    requestedSubModeSignal = signal<FlowSubMode | null>(null);
    mockWorkflowState = {
      requestedSubMode: requestedSubModeSignal,
      createNewWorkflow: vi.fn(),
    };

    mockQuickRunService = {
      selected: vi.fn().mockReturnValue(null),
      deselect: vi.fn(),
      openEditor: vi.fn(),
    };

    mockUiStateService = {
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

  it('should initialize activeSubMode from localStorage when valid stored value exists', async () => {
    storageMap.set('ui.flowActiveSubMode', 'builder');
    await createComponent();

    expect(component.activeSubMode()).toBe('builder');
  });

  it('should fall back to quick_run if no valid sub-mode is in localStorage', async () => {
    storageMap.set('ui.flowActiveSubMode', 'invalid_mode');
    await createComponent();

    expect(component.activeSubMode()).toBe('quick_run');
  });

  it('should save to localStorage and end layout edit when setSubMode is called', async () => {
    await createComponent();

    component.setSubMode('builder');
    expect(component.activeSubMode()).toBe('builder');
    expect(mockUiStateService.endLayoutEdit).toHaveBeenCalled();
    expect(mockLocalStorage.set).toHaveBeenCalledWith('ui.flowActiveSubMode', 'builder');

    component.setSubMode('quick_run');
    expect(component.activeSubMode()).toBe('quick_run');
    expect(mockLocalStorage.set).toHaveBeenCalledWith('ui.flowActiveSubMode', 'quick_run');
  });

  it('should update sub-mode when workflowState requests a sub-mode change', async () => {
    await createComponent();

    requestedSubModeSignal.set('builder');
    fixture.detectChanges();

    expect(component.activeSubMode()).toBe('builder');
    expect(mockWorkflowState.requestedSubMode()).toBeNull();
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
});
