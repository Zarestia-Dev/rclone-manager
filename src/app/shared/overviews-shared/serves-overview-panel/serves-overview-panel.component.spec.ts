import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { signal } from '@angular/core';
import { ServesOverviewPanelComponent } from './serves-overview-panel.component';
import { ServeListItem } from '@app/types';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';

describe('ServesOverviewPanelComponent', () => {
  let component: ServesOverviewPanelComponent;
  let fixture: ComponentFixture<ServesOverviewPanelComponent>;

  const mockServes: ServeListItem[] = [
    {
      id: 'serve-1',
      params: { type: 'http', fs: 'drive:' },
      origin: 'flow',
      workflow_id: 'wf-1',
    },
    {
      id: 'serve-2',
      params: { type: 'webdav', fs: 's3:' },
      origin: 'quickrun',
      quick_run_id: 'qr-1',
    },
    {
      id: 'serve-3',
      params: { type: 'ftp', fs: 'dropbox:' },
      origin: 'dashboard',
    },
  ] as unknown as ServeListItem[];

  beforeEach(async () => {
    const mockRemoteFacade = {
      activeRemotes: signal([
        {
          status: {
            serve: {
              serves: mockServes,
            },
          },
        },
      ]),
    };
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
        { provide: RemoteFacadeService, useValue: mockRemoteFacade },
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

    component.selectedOriginFilter.set('flow');
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
});
