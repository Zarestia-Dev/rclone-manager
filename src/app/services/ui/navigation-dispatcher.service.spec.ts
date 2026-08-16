import { TestBed } from '@angular/core/testing';
import { NavigationDispatcherService } from './navigation-dispatcher.service';
import { UiStateService } from './state/ui-state.service';
import { RemoteFacadeService } from '../facade/remote-facade.service';
import { PathService } from '../infrastructure/platform/path.service';
import { QuickRunService } from '../flow/quick-run.service';
import {
  JobInfo,
  Remote,
  ServeListItem,
  Automation,
  QuickRun,
  DEFAULT_JOB_STATS,
} from '@app/types';

describe('NavigationDispatcherService', () => {
  let service: NavigationDispatcherService;
  let mockUiStateService: jasmine.SpyObj<UiStateService>;
  let mockRemoteFacade: { activeRemotes: jasmine.Spy };
  let mockPathService: jasmine.SpyObj<PathService>;
  let mockQuickRunService: { quickRuns: jasmine.Spy; select: jasmine.Spy };

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

  beforeEach(() => {
    mockUiStateService = jasmine.createSpyObj('UiStateService', [
      'setMainView',
      'setTab',
      'setSelectedRemote',
    ]);
    mockRemoteFacade = {
      activeRemotes: jasmine.createSpy('activeRemotes').and.returnValue([mockRemote]),
    };
    mockPathService = jasmine.createSpyObj('PathService', ['getRemoteNameFromFs']);
    mockQuickRunService = {
      quickRuns: jasmine.createSpy('quickRuns').and.returnValue([mockQuickRun]),
      select: jasmine.createSpy('select'),
    };

    TestBed.configureTestingModule({
      providers: [
        NavigationDispatcherService,
        { provide: UiStateService, useValue: mockUiStateService },
        { provide: RemoteFacadeService, useValue: mockRemoteFacade },
        { provide: PathService, useValue: mockPathService },
        { provide: QuickRunService, useValue: mockQuickRunService },
      ],
    });

    service = TestBed.inject(NavigationDispatcherService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('navigateToJob', () => {
    it('should navigate to flow when origin is quickrun', () => {
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
      expect(mockQuickRunService.select).toHaveBeenCalledWith('qr-1');
    });

    it('should navigate to operations tab for standard job', () => {
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

    it('should navigate to mount tab for mount job', () => {
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
    it('should navigate to serve tab when remote is found from fs', () => {
      mockPathService.getRemoteNameFromFs.and.returnValue('test-remote');
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
    it('should navigate to operations tab for remote automation', () => {
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
  });
});
