import { TestBed } from '@angular/core/testing';
import { NavigationDispatcherService } from './navigation-dispatcher.service';
import { UiStateService } from './state/ui-state.service';
import { RemoteFacadeService } from '../facade/remote-facade.service';
import { PathService } from '../infrastructure/platform/path.service';
import { QuickRunService } from '../flow/quick-run.service';
import { WorkflowStorageService } from '../flow/workflow-storage.service';
import { WorkflowStateService } from '../flow/workflow-state.service';
import { Remote, ServeListItem, Automation, QuickRun } from '@app/types';
import { WorkflowDefinition } from '../../flow/workflow/types/workflow.types';
import { vi, describe, beforeEach, it, expect } from 'vitest';

describe('NavigationDispatcherService', () => {
  let service: NavigationDispatcherService;
  let mockUiStateService: {
    setMainView: ReturnType<typeof vi.fn>;
    setFlowSubMode: ReturnType<typeof vi.fn>;
    setTab: ReturnType<typeof vi.fn>;
    setSelectedRemote: ReturnType<typeof vi.fn>;
  };
  let mockRemoteFacade: { getRemote: ReturnType<typeof vi.fn> };
  let mockPathService: { getRemoteNameFromFs: ReturnType<typeof vi.fn> };
  let mockQuickRunService: {
    quickRuns: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
  };
  let mockWorkflowStorageService: {
    workflows: ReturnType<typeof vi.fn>;
  };
  let mockWorkflowStateService: {
    loadWorkflow: ReturnType<typeof vi.fn>;
  };

  const mockRemote = {
    name: 'test-remote',
    type: 'drive',
  } as unknown as Remote;

  const mockQuickRun = {
    id: 'qr-1',
    name: 'Sync Drive',
    backendName: 'Local',
    remoteName: 'test-remote',
    operationType: 'sync',
    sourcePaths: ['/local'],
    destinationPaths: ['test-remote:/backup'],
    status: 'idle',
    createdAt: '2026-01-01',
  } as unknown as QuickRun;

  const mockWorkflow = {
    id: 'wf-1',
    name: 'Nightly Sync',
    nodes: [],
    edges: [],
  } as unknown as WorkflowDefinition;

  beforeEach((): void => {
    mockUiStateService = {
      setMainView: vi.fn(),
      setFlowSubMode: vi.fn(),
      setTab: vi.fn(),
      setSelectedRemote: vi.fn(),
    };
    mockRemoteFacade = {
      getRemote: vi.fn((name: string) => (name === mockRemote.name ? mockRemote : undefined)),
    };
    mockPathService = {
      getRemoteNameFromFs: vi.fn(),
    };
    mockQuickRunService = {
      quickRuns: vi.fn().mockReturnValue([mockQuickRun]),
      select: vi.fn(),
    };
    mockWorkflowStorageService = {
      workflows: vi.fn().mockReturnValue([mockWorkflow]),
    };
    mockWorkflowStateService = {
      loadWorkflow: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        NavigationDispatcherService,
        { provide: UiStateService, useValue: mockUiStateService },
        { provide: RemoteFacadeService, useValue: mockRemoteFacade },
        { provide: PathService, useValue: mockPathService },
        { provide: QuickRunService, useValue: mockQuickRunService },
        { provide: WorkflowStorageService, useValue: mockWorkflowStorageService },
        { provide: WorkflowStateService, useValue: mockWorkflowStateService },
      ],
    });

    service = TestBed.inject(NavigationDispatcherService);
  });

  it('should be created', (): void => {
    expect(service).toBeTruthy();
  });

  describe('navigateToWorkflow', () => {
    it.each([
      { id: 'wf-1', name: undefined },
      { id: undefined, name: 'Nightly Sync' },
    ])('loads a workflow by ID or name: $id / $name', ({ id, name }) => {
      service.navigateToWorkflow(id, name);
      expect(mockUiStateService.setMainView).toHaveBeenCalledWith('flow');
      expect(mockUiStateService.setFlowSubMode).toHaveBeenCalledWith('builder');
      expect(mockWorkflowStateService.loadWorkflow).toHaveBeenCalledWith(mockWorkflow);
    });

    it('opens the builder without replacing the canvas when no workflow matches', () => {
      service.navigateToWorkflow('missing');
      expect(mockUiStateService.setMainView).toHaveBeenCalledWith('flow');
      expect(mockUiStateService.setFlowSubMode).toHaveBeenCalledWith('builder');
      expect(mockWorkflowStateService.loadWorkflow).not.toHaveBeenCalled();
    });
  });

  describe('navigateToRemote', () => {
    it.each(['operations', 'mount', 'serve'] as const)('selects the %s tab', tab => {
      service.navigateToRemote(mockRemote.name, tab);
      expect(mockUiStateService.setMainView).toHaveBeenCalledWith('main_menu');
      expect(mockUiStateService.setTab).toHaveBeenCalledWith(tab);
      expect(mockUiStateService.setSelectedRemote).toHaveBeenCalledWith(mockRemote);
    });

    it.each(['', 'missing'])('keeps the current view when remote %s is unavailable', name => {
      service.navigateToRemote(name);
      expect(mockUiStateService.setMainView).not.toHaveBeenCalled();
      expect(mockUiStateService.setTab).not.toHaveBeenCalled();
      expect(mockUiStateService.setSelectedRemote).not.toHaveBeenCalled();
    });
  });

  describe('navigateToServe', () => {
    it('should navigate to serve tab when remote is found from fs', (): void => {
      mockPathService.getRemoteNameFromFs.mockReturnValue('test-remote');
      const serve: ServeListItem = {
        id: 'serve-1',
        addr: 'localhost:8080',
        params: { fs: 'test-remote:path', type: 'http' },
      };

      service.navigateToServe(serve);

      expect(mockUiStateService.setMainView).toHaveBeenCalledWith('main_menu');
      expect(mockUiStateService.setTab).toHaveBeenCalledWith('serve');
      expect(mockUiStateService.setSelectedRemote).toHaveBeenCalledWith(mockRemote);
    });
  });

  describe('navigateToAutomation', () => {
    it('should navigate to operations tab for remote automation', (): void => {
      const automation = {
        id: 'auto-1',
        automationType: 'sync',
        remoteName: 'test-remote',
        profileName: 'default',
        status: 'enabled',
        backendName: 'Local',
        args: {
          srcPaths: ['/src'],
          dstPaths: ['/dst'],
          remoteName: 'test-remote',
          profileName: 'default',
        },
        createdAt: '2026-01-01',
        runCount: 0,
        successCount: 0,
        failureCount: 0,
        stoppedCount: 0,
      } as unknown as Automation;

      service.navigateToAutomation(automation);

      expect(mockUiStateService.setMainView).toHaveBeenCalledWith('main_menu');
      expect(mockUiStateService.setTab).toHaveBeenCalledWith('operations');
      expect(mockUiStateService.setSelectedRemote).toHaveBeenCalledWith(mockRemote);
    });

    it('should navigate to flow and load workflow when automation source is flow', (): void => {
      const automation = {
        id: 'wf-1',
        automationType: 'sync',
        remoteName: 'Workflow',
        profileName: 'Nightly Sync',
        status: 'enabled',
        backendName: 'Local',
        args: {
          source: 'flow',
          srcPaths: ['Nightly Sync'],
          dstPaths: ['Workflow Engine'],
          remoteName: 'Workflow',
          profileName: 'Nightly Sync',
        },
      } as unknown as Automation;

      service.navigateToAutomation(automation);

      expect(mockUiStateService.setMainView).toHaveBeenCalledWith('flow');
      expect(mockUiStateService.setFlowSubMode).toHaveBeenCalledWith('builder');
      expect(mockWorkflowStateService.loadWorkflow).toHaveBeenCalledWith(mockWorkflow);
    });

    it('should navigate to flow quick run when automation has quickrun profile', (): void => {
      const automation = {
        id: 'auto-2',
        automationType: 'sync',
        profileName: 'Sync Drive',
        status: 'enabled',
        backendName: 'Local',
        createdAt: '2026-01-01',
        runCount: 0,
        successCount: 0,
        failureCount: 0,
        stoppedCount: 0,
      } as unknown as Automation;

      service.navigateToAutomation(automation);

      expect(mockUiStateService.setMainView).toHaveBeenCalledWith('flow');
      expect(mockUiStateService.setFlowSubMode).toHaveBeenCalledWith('quick_run');
      expect(mockQuickRunService.select).toHaveBeenCalledWith('qr-1');
    });
  });

  describe('navigateToQuickRun', () => {
    it('should set main view to flow, set flow sub-mode to quick_run, and select quick run', (): void => {
      service.navigateToQuickRun('qr-1');

      expect(mockUiStateService.setMainView).toHaveBeenCalledWith('flow');
      expect(mockUiStateService.setFlowSubMode).toHaveBeenCalledWith('quick_run');
      expect(mockQuickRunService.select).toHaveBeenCalledWith('qr-1');
    });
  });

  describe('navigateToServe with quick run profile', () => {
    it('should navigate to flow quick run when serve has profile', (): void => {
      mockPathService.getRemoteNameFromFs.mockReturnValue(null);
      const serve: ServeListItem = {
        id: 'serve-2',
        addr: 'localhost:8080',
        profile: 'Sync Drive',
        params: { fs: 'remote:path', type: 'http' },
      };

      service.navigateToServe(serve);

      expect(mockUiStateService.setMainView).toHaveBeenCalledWith('flow');
      expect(mockUiStateService.setFlowSubMode).toHaveBeenCalledWith('quick_run');
      expect(mockQuickRunService.select).toHaveBeenCalledWith('qr-1');
    });
  });
});
