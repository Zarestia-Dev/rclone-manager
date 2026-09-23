import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { signal } from '@angular/core';

import { DeleteRemoteModalComponent, DeleteRemoteModalData } from './delete-remote-modal.component';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';
import { AutomationService } from 'src/app/services/operations/automation.service';
import { WorkflowStorageService } from 'src/app/services/flow/workflow-storage.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { Automation, JobInfo, MountedRemote, QuickRun, Remote, ServeListItem } from '@app/types';
import { WorkflowDefinition } from 'src/app/flow/workflow/types/workflow.types';

describe('DeleteRemoteModalComponent', () => {
  let fixture: ComponentFixture<DeleteRemoteModalComponent>;
  let component: DeleteRemoteModalComponent;
  let dialogRefSpy: { close: ReturnType<typeof vi.fn> };
  let remoteFacadeSpy: {
    orderedRemotes: ReturnType<typeof signal<Remote[]>>;
    mountedRemotes: ReturnType<typeof signal<MountedRemote[]>>;
    runningServes: ReturnType<typeof signal<ServeListItem[]>>;
    getRemoteSettings: ReturnType<typeof vi.fn>;
  };
  let jobServiceSpy: {
    jobs: ReturnType<typeof signal<JobInfo[]>>;
  };
  let quickRunServiceSpy: {
    quickRuns: ReturnType<typeof signal<QuickRun[]>>;
  };
  let automationServiceSpy: {
    automations: ReturnType<typeof signal<Automation[]>>;
  };
  let workflowStorageSpy: {
    workflows: ReturnType<typeof signal<WorkflowDefinition[]>>;
    loadAllWorkflows: ReturnType<typeof vi.fn>;
  };
  let pathServiceSpy: {
    getRemoteNameFromFs: ReturnType<typeof vi.fn>;
    normalizeRemoteName: ReturnType<typeof vi.fn>;
  };
  let iconServiceSpy: {
    getIconName: ReturnType<typeof vi.fn>;
  };

  const mockData: DeleteRemoteModalData = {
    remoteName: 'test-remote',
  };

  beforeEach(async () => {
    dialogRefSpy = { close: vi.fn() };
    remoteFacadeSpy = {
      orderedRemotes: signal<Remote[]>([
        { name: 'test-remote', type: 'drive' } as unknown as Remote,
        { name: 'other-remote', type: 's3' } as unknown as Remote,
      ]),
      mountedRemotes: signal<MountedRemote[]>([]),
      runningServes: signal<ServeListItem[]>([]),
      getRemoteSettings: vi.fn().mockReturnValue({
        syncConfigs: {
          'default-profile': { source: 'a', destination: 'b' },
        },
        mountConfigs: {
          'mount-profile': { mountPoint: '/mnt' },
        },
      }),
    };
    jobServiceSpy = {
      jobs: signal<JobInfo[]>([]),
    };
    quickRunServiceSpy = {
      quickRuns: signal<QuickRun[]>([]),
    };
    automationServiceSpy = {
      automations: signal<Automation[]>([]),
    };
    workflowStorageSpy = {
      workflows: signal<WorkflowDefinition[]>([]),
      loadAllWorkflows: vi.fn(),
    };
    pathServiceSpy = {
      getRemoteNameFromFs: vi.fn((fs: string) => (fs ? fs.split(':')[0] : '')),
      normalizeRemoteName: vi.fn((name?: string) => (name ? name.replace(/:$/, '').trim() : '')),
    };
    iconServiceSpy = {
      getIconName: vi.fn((type: string) => `icon-${type}`),
    };

    await TestBed.configureTestingModule({
      imports: [DeleteRemoteModalComponent],
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: dialogRefSpy },
        { provide: MAT_DIALOG_DATA, useValue: mockData },
        { provide: RemoteFacadeService, useValue: remoteFacadeSpy },
        { provide: JobManagementService, useValue: jobServiceSpy },
        { provide: QuickRunService, useValue: quickRunServiceSpy },
        { provide: AutomationService, useValue: automationServiceSpy },
        { provide: WorkflowStorageService, useValue: workflowStorageSpy },
        { provide: PathService, useValue: pathServiceSpy },
        { provide: IconService, useValue: iconServiceSpy },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(DeleteRemoteModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create the component with initial data', () => {
    expect(component).toBeTruthy();
    expect(component.remoteName).toBe('test-remote');
    expect(component.remoteType()).toBe('drive');
    expect(component.hasActiveOperations()).toBe(false);
  });

  it('should detect active mounts, serves, and jobs', () => {
    remoteFacadeSpy.mountedRemotes.set([
      { fs: 'test-remote:folder', mount_point: '/mnt/test' } as unknown as MountedRemote,
      { fs: 'other:folder', mount_point: '/mnt/other' } as unknown as MountedRemote,
    ]);
    remoteFacadeSpy.runningServes.set([
      {
        id: 'serve-1',
        addr: '127.0.0.1:8080',
        params: { fs: 'test-remote:serve', type: 'webdav' },
      } as unknown as ServeListItem,
      {
        id: 'serve-2',
        addr: '127.0.0.1:8081',
        params: { fs: 'other:serve', type: 'http' },
      } as unknown as ServeListItem,
    ]);
    jobServiceSpy.jobs.set([
      {
        jobid: 1,
        remote_name: 'test-remote',
        job_type: 'sync',
        status: 'Running',
      } as unknown as JobInfo,
      {
        jobid: 2,
        remote_name: 'test-remote',
        job_type: 'copy',
        status: 'Finished',
      } as unknown as JobInfo,
      {
        jobid: 3,
        remote_name: 'other',
        job_type: 'sync',
        status: 'Running',
      } as unknown as JobInfo,
    ]);

    expect(component.activeMounts().length).toBe(1);
    expect(component.activeMounts()[0].mount_point).toBe('/mnt/test');
    expect(component.activeServes().length).toBe(1);
    expect(component.activeServes()[0].id).toBe('serve-1');
    expect(component.activeJobs().length).toBe(1);
    expect(component.activeJobs()[0].jobid).toBe(1);
    expect(component.hasActiveOperations()).toBe(true);
  });

  it('should correctly list saved profiles from remote settings', () => {
    const profiles = component.profilesList();
    expect(profiles.length).toBeGreaterThan(0);
    const syncProfile = profiles.find(p => p.name === 'default-profile');
    expect(syncProfile).toBeDefined();
    expect(syncProfile?.type).toBe('sync');
    const mountProfile = profiles.find(p => p.name === 'mount-profile');
    expect(mountProfile).toBeDefined();
    expect(mountProfile?.type).toBe('mount');
  });

  it('should filter associated quick runs and automations by remoteName', () => {
    quickRunServiceSpy.quickRuns.set([
      {
        id: 'qr-1',
        name: 'QR 1',
        remoteName: 'test-remote',
        operationType: 'sync',
      } as unknown as QuickRun,
      {
        id: 'qr-2',
        name: 'QR 2',
        remoteName: 'other',
        operationType: 'copy',
      } as unknown as QuickRun,
    ]);
    automationServiceSpy.automations.set([
      {
        id: 'auto-1',
        profileName: 'Auto 1',
        remoteName: 'test-remote',
      } as unknown as Automation,
      {
        id: 'auto-2',
        profileName: 'Auto 2',
        remoteName: 'other',
      } as unknown as Automation,
    ]);

    expect(component.quickRunsList().length).toBe(1);
    expect(component.quickRunsList()[0].name).toBe('QR 1');
    expect(component.automationsList().length).toBe(1);
    expect(component.automationsList()[0].id).toBe('auto-1');
  });

  it('should filter associated workflows referencing the remote through various node configs', () => {
    quickRunServiceSpy.quickRuns.set([
      {
        id: 'qr-matched',
        name: 'Matched QR',
        remoteName: 'test-remote',
      } as unknown as QuickRun,
      {
        id: 'qr-other',
        name: 'Other QR',
        remoteName: 'other',
      } as unknown as QuickRun,
    ]);

    workflowStorageSpy.workflows.set([
      {
        id: 'wf-direct',
        name: 'Direct Remote Workflow',
        nodes: [
          {
            id: 'n1',
            type: 'sync',
            config: { remoteName: 'test-remote' },
          },
        ],
      } as unknown as WorkflowDefinition,
      {
        id: 'wf-path',
        name: 'Path Remote Workflow',
        nodes: [
          {
            id: 'n2',
            type: 'copy',
            config: {
              config: {
                rclone: { srcFs: 'test-remote:photos', dstFs: '/local/backup' },
              },
            },
          },
        ],
      } as unknown as WorkflowDefinition,
      {
        id: 'wf-quickrun',
        name: 'QuickRun Remote Workflow',
        nodes: [
          {
            id: 'n3',
            type: 'quick_run',
            config: { quickRunId: 'qr-matched' },
          },
        ],
      } as unknown as WorkflowDefinition,
      {
        id: 'wf-other',
        name: 'Unrelated Workflow',
        nodes: [
          {
            id: 'n4',
            type: 'sync',
            config: { remoteName: 'other' },
          },
          {
            id: 'n5',
            type: 'quick_run',
            config: { quickRunId: 'qr-other' },
          },
        ],
      } as unknown as WorkflowDefinition,
      {
        id: 'wf-empty',
        name: 'Empty Workflow',
        nodes: [],
      } as unknown as WorkflowDefinition,
    ]);

    const matching = component.workflowsList();
    expect(matching.length).toBe(3);
    const ids = matching.map(w => w.id);
    expect(ids).toContain('wf-direct');
    expect(ids).toContain('wf-path');
    expect(ids).toContain('wf-quickrun');
    expect(ids).not.toContain('wf-other');
    expect(ids).not.toContain('wf-empty');
  });

  it('should return empty workflowsList when no workflows reference the remote', () => {
    workflowStorageSpy.workflows.set([
      {
        id: 'wf-unrelated',
        name: 'Unrelated',
        nodes: [{ id: 'n1', type: 'manual', config: {} }],
      } as unknown as WorkflowDefinition,
    ]);

    expect(component.workflowsList().length).toBe(0);
  });

  it('should close dialog with true on confirm', () => {
    component.onConfirm();
    expect(dialogRefSpy.close).toHaveBeenCalledWith(true);
  });

  it('should close dialog with false on cancel', () => {
    component.onCancel();
    expect(dialogRefSpy.close).toHaveBeenCalledWith(false);
  });

  it('should handle escape key when not deleting', () => {
    const event = new KeyboardEvent('keydown', { key: 'Escape' });
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

    component.onEscapeKey(event);
    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(dialogRefSpy.close).toHaveBeenCalledWith(false);
  });

  it('should not handle escape key when deleting is in progress', () => {
    component.isDeleting.set(true);
    const event = new KeyboardEvent('keydown', { key: 'Escape' });
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

    component.onEscapeKey(event);
    expect(preventDefaultSpy).not.toHaveBeenCalled();
    expect(dialogRefSpy.close).not.toHaveBeenCalled();
  });

  it('should return correct operation icon and pill class', () => {
    expect(component.getOpIcon('sync')).toBeDefined();
    expect(component.getOpPillClass('sync')).toContain('p-');
    expect(component.getOpIcon('unknown-op')).toBe('quick-run');
    expect(component.getOpPillClass('unknown-op')).toBe('p-accent');
  });
});
