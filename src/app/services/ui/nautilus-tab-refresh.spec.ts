import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslateService } from '@ngx-translate/core';
import { ExplorerRoot, JobChangeEvent } from '@app/types';
import { NautilusTabService } from './nautilus-tab.service';
import { NautilusService } from './nautilus.service';
import { LocalStorageService } from './state/local-storage.service';
import { NotificationService } from './notification.service';
import { PathService } from '../infrastructure/platform/path.service';
import { BackendService } from '../infrastructure/system/backend.service';
import { RemoteFileOperationsService } from '../remote/remote-file-operations.service';
import { JobManagementService } from '../operations/job-management.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { FileViewerService } from './file-viewer.service';

const source: ExplorerRoot = { name: 'source', label: 'Source', isLocal: false, type: 'drive' };
const destination: ExplorerRoot = {
  name: 'destination',
  label: 'Destination',
  isLocal: false,
  type: 'drive',
};
const local: ExplorerRoot = { name: '/', label: 'Local', isLocal: true, type: 'local' };

describe('Nautilus operation refresh', () => {
  let service: NautilusTabService;
  let events: Subject<JobChangeEvent>;
  const getRemotePaths = vi.fn();
  const isWindows = vi.fn();

  beforeEach(() => {
    events = new Subject<JobChangeEvent>();
    isWindows.mockReturnValue(false);
    getRemotePaths.mockReset().mockResolvedValue({ list: [] });
    TestBed.configureTestingModule({
      providers: [
        NautilusTabService,
        PathService,
        { provide: BackendService, useValue: { isWindows } },
        { provide: TranslateService, useValue: { instant: (key: string): string => key } },
        {
          provide: LocalStorageService,
          useValue: {
            get: (_: string, fallback: unknown): unknown => fallback,
            set: vi.fn(),
            remove: vi.fn(),
          },
        },
        { provide: NotificationService, useValue: { showError: vi.fn() } },
        {
          provide: RemoteFileOperationsService,
          useValue: {
            getRemotePaths,
            getStat: vi.fn().mockResolvedValue({ item: { IsDir: true } }),
          },
        },
        {
          provide: JobManagementService,
          useValue: { stopJobsByGroup: vi.fn().mockResolvedValue(undefined) },
        },
        {
          provide: EventListenersService,
          useValue: { listenToJobCacheChanged: (): Subject<JobChangeEvent> => events },
        },
        { provide: FileViewerService, useValue: {} },
        {
          provide: NautilusService,
          useValue: {
            allRemotesLookup: signal([source, destination, local]),
            lookupRemoteByName: (name: string): ExplorerRoot | undefined =>
              [source, destination, local].find(remote => remote.name === name),
          },
        },
      ],
    });
    TestBed.inject(PathService).setRemoteNames(['source', 'destination']);
    service = TestBed.inject(NautilusTabService);
  });

  function finish(changes: Partial<JobChangeEvent> = {}): void {
    events.next({ jobId: '42', status: 'Completed', remote: 'source', ...changes });
  }

  it('refreshes a cross-remote destination even when no source tab is open', () => {
    service.createTab(destination, 'target');
    finish({ sources: ['source:origin/file'], destination: 'destination:target' });
    expect(service.refreshTrigger()).toBe(1);
    expect(service.tabs()[0].left.refreshTrigger()).toBe(1);
  });

  it('refreshes both split panes exactly once for duplicate paths', () => {
    service.createTab(source, 'folder');
    service.toggleSplit();
    service.refreshAffectedPaths([
      { remote: 'source:', path: '/folder/' },
      { remote: 'source', path: 'folder' },
    ]);
    expect(service.refreshTrigger()).toBe(1);
    expect(service.refreshTriggerRight()).toBe(1);
    expect(service.tabs()[0].left.refreshTrigger()).toBe(1);
    expect(service.tabs()[0].right?.refreshTrigger()).toBe(1);
  });

  it('retains all batch source paths, including filenames containing commas', () => {
    service.createTab(source, 'first');
    service.createTab(source, 'second');
    finish({
      remote: 'multiple',
      sources: ['source:first/a, b.txt', 'source:second/c.txt'],
      destination: 'trash',
    });
    expect(service.tabs().map(tab => tab.left.refreshTrigger())).toEqual([1, 1]);
  });

  it('invalidates inactive tabs without refreshing the unrelated active location', () => {
    service.createTab(destination, 'target');
    service.createTab(destination, 'elsewhere');
    finish({ destination: 'destination:target' });
    expect(service.tabs()[0].left.refreshTrigger()).toBe(1);
    expect(service.refreshTrigger()).toBe(0);
    service.switchTab(0);
    expect(service.refreshTrigger()).toBe(1);
  });

  it('refreshes an affected subtree and its parent without reloading sibling subtrees', () => {
    service.createTab(source, 'folder/child/deep');
    service.createTab(source, 'folder-other/child');
    service.createTab(source, '');
    finish({ sources: ['source:folder'] });
    expect(service.tabs().map(tab => tab.left.refreshTrigger())).toEqual([1, 0, 1]);
  });

  it.each(['Failed', 'Stopped'] as const)('refreshes partial changes when a job is %s', status => {
    service.createTab(source, 'folder');
    finish({ status, sources: ['source:folder/file'] });
    expect(service.refreshTrigger()).toBe(1);
  });

  it('does not refresh a listing merely because the operation has started', () => {
    service.createTab(source, 'folder');
    finish({ status: 'Running', sources: ['source:folder/file'] });
    expect(service.refreshTrigger()).toBe(0);
  });

  it('resolves absolute local paths independently of the job remote', () => {
    service.createTab(local, '/tmp/files');
    finish({ sources: ['/tmp/files/a.txt'], destination: 'destination:folder' });
    expect(service.refreshTrigger()).toBe(1);
  });

  it('matches Windows local paths with drive roots and backslashes', () => {
    isWindows.mockReturnValue(true);
    service.createTab({ ...local, name: 'C:\\' }, 'C:/files');
    finish({ sources: ['C:\\files\\a.txt'] });
    expect(service.refreshTrigger()).toBe(1);
  });

  it('supports old single-source events and relative mutation paths', () => {
    service.createTab(source, 'folder');
    finish({ source: 'folder/new-dir' });
    expect(service.refreshTrigger()).toBe(1);
  });
  it('reloads an invalidated cached tab only when it becomes active', async () => {
    service.createTab(destination, 'target');
    TestBed.tick();
    await Promise.resolve();
    await Promise.resolve();
    expect(service.tabs()[0].left.loadedTrigger).toBe(0);
    service.createTab(destination, 'other');
    TestBed.tick();
    await Promise.resolve();
    getRemotePaths.mockClear();
    finish({ destination: 'destination:target' });
    TestBed.tick();
    expect(getRemotePaths).not.toHaveBeenCalled();
    service.switchTab(0);
    TestBed.tick();
    await Promise.resolve();
    expect(getRemotePaths).toHaveBeenCalledOnce();
    expect(getRemotePaths.mock.calls[0][1]).toBe('target');
  });

  it('does not reload a hidden right pane after split view closes', async () => {
    service.createTab(source, 'folder');
    service.toggleSplit();
    TestBed.tick();
    await Promise.resolve();
    service.toggleSplit();
    TestBed.tick();
    getRemotePaths.mockClear();
    finish({ sources: ['source:folder/file'] });
    TestBed.tick();
    expect(service.refreshTriggerRight()).toBe(0);
    expect(getRemotePaths).toHaveBeenCalledOnce();
  });

  it('refreshes the root destination of a URL copy', () => {
    service.createTab(destination, '');
    finish({ remote: 'destination', sources: ['https://example.com/file'], destination: '' });
    expect(service.refreshTrigger()).toBe(1);
  });
});
