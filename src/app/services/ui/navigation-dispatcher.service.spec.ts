import { TestBed } from '@angular/core/testing';
import { NavigationDispatcherService } from './navigation-dispatcher.service';
import { UiStateService } from './state/ui-state.service';
import { RemoteFacadeService } from '../facade/remote-facade.service';
import { PathService } from '../infrastructure/platform/path.service';
import { QuickRunService } from '../flow/quick-run.service';
import { WorkflowStorageService } from '../flow/workflow-storage.service';
import { WorkflowStateService } from '../flow/workflow-state.service';
import {
  JobInfo,
  Remote,
  ServeListItem,
  Automation,
  QuickRun,
  DEFAULT_JOB_STATS,
} from '@app/types';
import { WorkflowDefinition } from '../../flow/workflow/types/workflow.types';
import { vi, describe, beforeEach, it, expect } from 'vitest';

describe('NavigationDispatcherService', () => {
  let service: NavigationDispatcherService;
  let mockUiStateService: {
    setMainView: ReturnType<typeof vi.fn>;
    setTab: ReturnType<typeof vi.fn>;
    setSelectedRemote: ReturnType<typeof vi.fn>;
  };
  let mockRemoteFacade: { activeRemotes: ReturnType<typeof vi.fn> };
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
    requestedSubMode: {
      set: ReturnType<typeof vi.fn>;
    };
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
      setTab: vi.fn(),
      setSelectedRemote: vi.fn(),
    };
    mockRemoteFacade = {
      activeRemotes: vi.fn().mockReturnValue([mockRemote]),
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
      requestedSubMode: {
        set: vi.fn(),
      },
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

  describe('navigateToJob', () => {
    it('should navigate to flow when origin is quickrun', (): void => {
      const job: JobInfo = {
        jobid: 1,
        execute_id: 'exec-1',
        job_type: 'sync',
        source: '/local',
        destination: 'test-remote:/backup',
        start_time: '2026-01-01',
        status: 'Running',
        remote_name: 'test-remote',
        stats: DEFAULT_JOB_STATS,
        origin: 'quickrun',
        profile: 'qr-1',
      };

      service.navigateToJob(job);

      expect(mockUiStateService.setMainView).toHaveBeenCalledWith('flow');
      expect(mockWorkflowStateService.requestedSubMode.set).toHaveBeenCalledWith('quick_run');
      expect(mockQuickRunService.select).toHaveBeenCalledWith('qr-1');
    });

    it('should navigate to flow and load workflow when job origin is flow', (): void => {
      const job: JobInfo = {
        jobid: 3,
        execute_id: 'exec-3',
        job_type: 'sync',
        source: '/local',
        destination: 'test-remote:/backup',
        start_time: '2026-01-01',
        status: 'Running',
        remote_name: 'Workflow',
        stats: DEFAULT_JOB_STATS,
        origin: 'flow',
        profile: 'wf-1',
      };

      service.navigateToJob(job);

      expect(mockUiStateService.setMainView).toHaveBeenCalledWith('flow');
      expect(mockWorkflowStateService.loadWorkflow).toHaveBeenCalledWith(mockWorkflow);
    });

    it('should navigate to operations tab for standard job', (): void => {
      const job: JobInfo = {
        jobid: 1,
        execute_id: 'exec-1',
        job_type: 'sync',
        source: '/local',
        destination: 'test-remote:/backup',
        start_time: '2026-01-01',
        status: 'Running',
        remote_name: 'test-remote',
        stats: DEFAULT_JOB_STATS,
        origin: 'dashboard',
      };

      service.navigateToJob(job);

      expect(mockUiStateService.setMainView).toHaveBeenCalledWith('main_menu');
      expect(mockUiStateService.setTab).toHaveBeenCalledWith('operations');
      expect(mockUiStateService.setSelectedRemote).toHaveBeenCalledWith(mockRemote);
    });

    it('should navigate to mount tab for mount job', (): void => {
      const job: JobInfo = {
        jobid: 2,
        execute_id: 'exec-2',
        job_type: 'mount',
        source: 'test-remote:',
        destination: '/mnt/test',
        start_time: '2026-01-01',
        status: 'Running',
        remote_name: 'test-remote',
        stats: DEFAULT_JOB_STATS,
      };

      service.navigateToJob(job);

      expect(mockUiStateService.setTab).toHaveBeenCalledWith('mount');
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
      expect(mockWorkflowStateService.requestedSubMode.set).toHaveBeenCalledWith('quick_run');
      expect(mockQuickRunService.select).toHaveBeenCalledWith('qr-1');
    });
  });

  describe('navigateToQuickRun', () => {
    it('should set main view to flow, set requestedSubMode to quick_run, and select quick run', (): void => {
      service.navigateToQuickRun('qr-1');

      expect(mockUiStateService.setMainView).toHaveBeenCalledWith('flow');
      expect(mockWorkflowStateService.requestedSubMode.set).toHaveBeenCalledWith('quick_run');
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
      expect(mockWorkflowStateService.requestedSubMode.set).toHaveBeenCalledWith('quick_run');
      expect(mockQuickRunService.select).toHaveBeenCalledWith('qr-1');
    });
  });
});
