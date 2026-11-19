import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { signal } from '@angular/core';
import { ServesOverviewPanelComponent } from './serves-overview-panel.component';
import { ExecutionScope, ServeListItem } from '@app/types';
import {
  buildRemoteProfileStatus,
  readRemoteProfiles,
} from 'src/app/services/remote/utils/remote-profile-state.util';
import { ServeManagementService } from 'src/app/services/operations/serve-management.service';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';

describe('ServesOverviewPanelComponent', () => {
  let component: ServesOverviewPanelComponent;
  let fixture: ComponentFixture<ServesOverviewPanelComponent>;
  const runningServes = signal<ServeListItem[]>([]);

  const mockServes: ServeListItem[] = [
    {
      id: 'serve-1',
      addr: 'http://localhost:8080',
      params: { type: 'http', fs: 'drive:' },
      origin: 'workflow',
      starter: {
        kind: 'workflow',
        workflowId: 'wf-1',
        workflowName: 'Workflow',
        nodeId: 'node',
        ancestors: [],
      },
    },
    {
      id: 'serve-2',
      addr: 'http://localhost:8081',
      params: { type: 'webdav', fs: 's3:' },
      origin: 'quickrun',
      starter: { kind: 'quick_run', id: 'qr-1', name: 'qr-1' },
    },
    {
      id: 'serve-3',
      addr: 'ftp://localhost:8082',
      params: { type: 'ftp', fs: 'dropbox:' },
      origin: 'dashboard',
    },
  ];

  beforeEach(async () => {
    runningServes.set(mockServes);
    const mockQuickRunService = {
      quickRuns: signal([]),
    };
    const mockBackendService = {
      backends: signal([{ name: 'Local', isLocal: true, os: 'linux' }]),
      activeBackend: signal('Local'),
      isWindows: signal(false),
    };

    await TestBed.configureTestingModule({
      imports: [ServesOverviewPanelComponent],
      providers: [
        provideTranslateService(),
        { provide: ServeManagementService, useValue: { runningServes } },
        { provide: QuickRunService, useValue: mockQuickRunService },
        { provide: BackendService, useValue: mockBackendService },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ServesOverviewPanelComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('filters serves by flow origin correctly', () => {
    expect(component.allServes().length).toBe(3);

    component.selectedOriginFilter.set('workflow');
    fixture.detectChanges();
    expect(component.allServes().length).toBe(1);
    expect(component.allServes()[0].id).toBe('serve-1');
  });

  it('filters serves by quickrun origin correctly', () => {
    component.selectedOriginFilter.set('quickrun');
    fixture.detectChanges();
    expect(component.allServes().length).toBe(1);
    expect(component.allServes()[0].id).toBe('serve-2');
  });

  it('filters serves by dashboard origin correctly', () => {
    component.selectedOriginFilter.set('dashboard');
    fixture.detectChanges();
    expect(component.allServes().length).toBe(1);
    expect(component.allServes()[0].id).toBe('serve-3');
  });

  it('keeps Quick Run and Flow serves even when remote profile state excludes them', () => {
    const profileStatus = buildRemoteProfileStatus({
      profiles: readRemoteProfiles({}),
      jobs: [],
      mounts: [],
      serves: mockServes,
    });
    expect(profileStatus.serve.serves.map(serve => serve.id)).toEqual(['serve-3']);
    expect(component.allServes()).toEqual(mockServes);
  });

  it.each<[ExecutionScope, string[]]>([
    [{ origin: undefined }, ['dashboard']],
    [{ origin: 'dashboard', starter: { kind: 'quick_run', id: 'qr', name: 'qr' } }, ['quickrun']],
    [
      {
        origin: 'automation',
        starter: {
          kind: 'workflow',
          workflowId: 'wf',
          workflowName: 'Workflow',
          nodeId: 'node',
          ancestors: [],
        },
      },
      ['workflow'],
    ],
    [
      {
        origin: 'quickrun',
        starter: {
          kind: 'quick_run',
          id: 'qr',
          name: 'qr',
          workflow: { workflowId: 'wf', workflowName: 'Workflow', nodeId: 'node', ancestors: [] },
        },
      },
      ['workflow'],
    ],
    [{ origin: 'workflow' }, ['workflow']],
    // Work of a remote's own profiles, however it was started, is dashboard work.
    [{ origin: 'startup' }, ['dashboard', 'startup']],
    [{ origin: 'filemanager' }, ['dashboard', 'filemanager']],
  ])('uses execution ownership for filtering: %j', (scope, shownUnder) => {
    const serve: ServeListItem = { ...mockServes[2], ...scope };
    runningServes.set([serve]);
    for (const filter of ['dashboard', 'quickrun', 'workflow', 'filemanager', 'startup']) {
      component.selectedOriginFilter.set(filter);
      expect(component.allServes()).toEqual(shownUnder.includes(filter) ? [serve] : []);
    }
  });

  it('reacts to serves from remotes outside the current catalogue', () => {
    runningServes.set([{ ...mockServes[1], params: { fs: 'deleted-remote:', type: 'http' } }]);
    expect(component.allServes()).toEqual(runningServes());
    runningServes.set([]);
    expect(component.allServes()).toEqual([]);
  });
});
