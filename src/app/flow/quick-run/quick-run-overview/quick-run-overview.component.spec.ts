import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideTranslateService } from '@ngx-translate/core';
import { MatSnackBar } from '@angular/material/snack-bar';

import { QuickRunOverviewComponent } from './quick-run-overview.component';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { LocalStorageService } from 'src/app/services/ui/state/local-storage.service';
import { AutomationService } from 'src/app/services/operations/automation.service';
import { NavigationDispatcherService } from 'src/app/services/ui/navigation-dispatcher.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { QuickRun, Remote } from '@app/types';

describe('QuickRunOverviewComponent', () => {
  let fixture: ComponentFixture<QuickRunOverviewComponent>;
  let component: QuickRunOverviewComponent;

  let quickRunsSignal = signal<QuickRun[]>([]);
  let runningIdsSignal = signal<Set<string>>(new Set());
  let orderedRemotesSignal = signal<Remote[]>([]);

  let mockQuickRunService: {
    quickRuns: typeof quickRunsSignal;
    runningIds: typeof runningIdsSignal;
    select: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    openEditor: ReturnType<typeof vi.fn>;
  };

  let mockJobService: {
    activeJobs: ReturnType<typeof signal>;
    jobs: ReturnType<typeof signal>;
  };

  let mockAppSettingsService: {
    getSettingValue: ReturnType<typeof vi.fn>;
    saveSetting: ReturnType<typeof vi.fn>;
  };

  let mockLocalStorage: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
  };

  let mockSnackBar: {
    open: ReturnType<typeof vi.fn>;
  };

  let mockAutomationService: {
    automations: ReturnType<typeof signal>;
  };

  let mockNavigationDispatcher: {
    onItemAction: ReturnType<typeof vi.fn>;
  };

  let mockPathService: {
    splitFsPath: ReturnType<typeof vi.fn>;
  };

  let mockUiStateService: {
    isEditingOverview: ReturnType<typeof vi.fn>;
    toggleLayoutEdit: ReturnType<typeof vi.fn>;
  };

  let mockIconService: {
    getIconName: ReturnType<typeof vi.fn>;
  };

  let mockRemoteFacade: {
    orderedRemotes: typeof orderedRemotesSignal;
    openRemoteInFiles: ReturnType<typeof vi.fn>;
  };

  const createComponent = async (): Promise<void> => {
    await TestBed.configureTestingModule({
      imports: [QuickRunOverviewComponent],
      providers: [
        provideTranslateService(),
        { provide: QuickRunService, useValue: mockQuickRunService },
        { provide: JobManagementService, useValue: mockJobService },
        { provide: AppSettingsService, useValue: mockAppSettingsService },
        { provide: LocalStorageService, useValue: mockLocalStorage },
        { provide: MatSnackBar, useValue: mockSnackBar },
        { provide: AutomationService, useValue: mockAutomationService },
        { provide: NavigationDispatcherService, useValue: mockNavigationDispatcher },
        { provide: PathService, useValue: mockPathService },
        { provide: UiStateService, useValue: mockUiStateService },
        { provide: IconService, useValue: mockIconService },
        { provide: RemoteFacadeService, useValue: mockRemoteFacade },
      ],
    })
      .overrideComponent(QuickRunOverviewComponent, {
        set: {
          template: '',
          imports: [],
        },
      })
      .compileComponents();

    fixture = TestBed.createComponent(QuickRunOverviewComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  };

  beforeEach(() => {
    TestBed.resetTestingModule();
    quickRunsSignal = signal<QuickRun[]>([]);
    runningIdsSignal = signal<Set<string>>(new Set());
    orderedRemotesSignal = signal<Remote[]>([]);

    mockQuickRunService = {
      quickRuns: quickRunsSignal,
      runningIds: runningIdsSignal,
      select: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      openEditor: vi.fn(),
    };

    mockJobService = {
      activeJobs: signal([]),
      jobs: signal([]),
    };

    mockAppSettingsService = {
      getSettingValue: vi.fn().mockResolvedValue(null),
      saveSetting: vi.fn().mockResolvedValue(undefined),
    };

    mockLocalStorage = {
      get: vi.fn((_key: string, fallback: unknown) => fallback),
      set: vi.fn(),
    };

    mockSnackBar = {
      open: vi.fn(),
    };

    mockAutomationService = {
      automations: signal([]),
    };

    mockNavigationDispatcher = {
      onItemAction: vi.fn(),
    };

    mockPathService = {
      splitFsPath: vi.fn().mockReturnValue({ remote: 'drive', path: 'folder' }),
    };

    mockUiStateService = {
      isEditingOverview: vi.fn().mockReturnValue(false),
      toggleLayoutEdit: vi.fn(),
    };

    mockIconService = {
      getIconName: vi.fn((type: string) => `icon-${type}`),
    };

    mockRemoteFacade = {
      orderedRemotes: orderedRemotesSignal,
      openRemoteInFiles: vi.fn(),
    };
  });

  it('should list all remotes in remoteGroups even when quickRuns is empty (count = 0)', async () => {
    orderedRemotesSignal.set([
      { name: 'gdrive', type: 'drive' } as Remote,
      { name: 's3backup', type: 's3' } as Remote,
    ]);
    quickRunsSignal.set([]);

    await createComponent();

    const groups = component.remoteGroups();
    expect(groups).toEqual([
      { remoteName: 'gdrive', count: 0, icon: 'icon-drive' },
      { remoteName: 's3backup', count: 0, icon: 'icon-s3' },
    ]);
  });

  it('should count existing quick runs for each remote correctly', async () => {
    orderedRemotesSignal.set([
      { name: 'gdrive', type: 'drive' } as Remote,
      { name: 'onedrive', type: 'onedrive' } as Remote,
    ]);
    quickRunsSignal.set([
      { id: 'qr-1', name: 'Sync Photos', remoteName: 'gdrive' } as QuickRun,
      { id: 'qr-2', name: 'Backup Docs', remoteName: 'gdrive' } as QuickRun,
    ]);

    await createComponent();

    const groups = component.remoteGroups();
    expect(groups).toEqual([
      { remoteName: 'gdrive', count: 2, icon: 'icon-drive' },
      { remoteName: 'onedrive', count: 0, icon: 'icon-onedrive' },
    ]);
  });

  it('should include local or unknown remotes present in quickRuns', async () => {
    orderedRemotesSignal.set([{ name: 'gdrive', type: 'drive' } as Remote]);
    quickRunsSignal.set([
      { id: 'qr-local', name: 'Local Backup', remoteName: 'local' } as QuickRun,
    ]);

    await createComponent();

    const groups = component.remoteGroups();
    expect(groups).toContainEqual({ remoteName: 'gdrive', count: 0, icon: 'icon-drive' });
    expect(groups).toContainEqual({ remoteName: 'local', count: 1, icon: 'hard-drive' });
  });

  it('should filter quick runs by selected remote name, and return all when filter is null', async () => {
    orderedRemotesSignal.set([{ name: 'gdrive', type: 'drive' } as Remote]);
    const qr1 = { id: 'qr-1', name: 'Run 1', remoteName: 'gdrive' } as QuickRun;
    const qr2 = { id: 'qr-2', name: 'Run 2', remoteName: 'other' } as QuickRun;
    quickRunsSignal.set([qr1, qr2]);

    await createComponent();

    // Default: null filter -> all quick runs
    expect(component.filteredQuickRuns()).toEqual([qr1, qr2]);

    // Set filter to 'gdrive'
    component.setRemoteFilter('gdrive');
    expect(component.filteredQuickRuns()).toEqual([qr1]);

    // Set filter to 'unknown' (empty)
    component.setRemoteFilter('non-existent');
    expect(component.filteredQuickRuns()).toEqual([]);

    // Clear filter
    component.setRemoteFilter(null);
    expect(component.filteredQuickRuns()).toEqual([qr1, qr2]);
  });

  it('should open editor for a remote when onCreateQuickRunForRemote is called', async () => {
    await createComponent();

    component.onCreateQuickRunForRemote('my-remote');
    expect(mockQuickRunService.openEditor).toHaveBeenCalledWith(undefined, undefined, 'my-remote');
  });
});
