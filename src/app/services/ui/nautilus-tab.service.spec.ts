import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { EMPTY } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslateService } from '@ngx-translate/core';
import { createMinimalEntry, ExplorerRoot } from '@app/types';
import { NautilusNavigation } from './navigation-history.service';
import { NautilusTabService } from './nautilus-tab.service';
import { NautilusService } from './nautilus.service';
import { LocalStorageService } from './state/local-storage.service';
import { NotificationService } from './notification.service';
import { PathService } from '../infrastructure/platform/path.service';
import { RemoteFileOperationsService } from '../remote/remote-file-operations.service';
import { JobManagementService } from '../operations/job-management.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { FileViewerService } from './file-viewer.service';

const remote: ExplorerRoot = { name: 'drive', label: 'Drive', isLocal: false, type: 'drive' };

function deferredStat(): {
  promise: Promise<{ item: { IsDir: boolean } }>;
  resolve: (value: { item: { IsDir: boolean } }) => void;
} {
  let resolve!: (value: { item: { IsDir: boolean } }) => void;
  const promise = new Promise<{ item: { IsDir: boolean } }>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function snapshot(service: NautilusTabService): NautilusNavigation {
  const value = service.navigationSnapshot();
  if (!value) throw new Error('Expected an active pane');
  return value;
}

describe('NautilusTabService navigation', () => {
  let service: NautilusTabService;
  const getStat = vi.fn();
  const getRemotePaths = vi.fn();
  beforeEach(() => {
    TestBed.resetTestingModule();
    getStat.mockReset().mockResolvedValue({ item: { IsDir: true } });
    getRemotePaths.mockReset().mockResolvedValue({ list: [] });
    TestBed.configureTestingModule({
      providers: [
        NautilusTabService,
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
          provide: PathService,
          useValue: {
            getDisplaySegment: (_: unknown, path: string): string => path,
            normalizeRemoteForRclone: (name: string): string => name,
            normalizeRemoteName: (name: string): string => name,
            getParentPath: (path: string): string => path.split('/').slice(0, -1).join('/'),
          },
        },
        {
          provide: RemoteFileOperationsService,
          useValue: { getStat, getRemotePaths },
        },
        {
          provide: JobManagementService,
          useValue: { stopJobsByGroup: vi.fn().mockResolvedValue(undefined) },
        },
        {
          provide: EventListenersService,
          useValue: { listenToJobCacheChanged: (): typeof EMPTY => EMPTY },
        },
        { provide: FileViewerService, useValue: {} },
        {
          provide: NautilusService,
          useValue: {
            allRemotesLookup: signal([remote]),
            lookupRemoteByName: (name: string): ExplorerRoot | null =>
              name === remote.name ? remote : null,
          },
        },
      ],
    });
    service = TestBed.inject(NautilusTabService);
    service.createTab(null);
  });

  it('deduplicates panel navigation and truncates the forward branch', async () => {
    await service.navigate(remote, 'A', true);
    await service.navigate(remote, 'A', true);
    await service.navigate(remote, 'B', true);
    expect(service.tabs()[0].left.history).toHaveLength(3);
    service.goBack();
    await Promise.resolve();
    await service.navigate(remote, 'C', true);
    expect(service.tabs()[0].left.history.map(entry => entry.path)).toEqual(['', 'A', 'C']);
  });

  async function settleFiles(): Promise<void> {
    TestBed.tick();
    await Promise.resolve();
    await Promise.resolve();
  }

  it('keeps the new directory empty and loading through sidebar restoration and tab switching', async () => {
    getRemotePaths.mockResolvedValueOnce({ list: [createMinimalEntry('old.mp3')] });
    service.executeNavigate(remote, 'old', true);
    await settleFiles();
    expect(service.rawFiles()).toHaveLength(1);

    getRemotePaths.mockReturnValueOnce(new Promise(vi.fn()));
    service.executeNavigate(remote, 'new', true);
    const location = snapshot(service);
    service.restoreNavigation(location);
    service.createTab(null);
    service.switchTab(0);
    expect(service.activePath()).toBe('new');
    expect(service.rawFiles()).toEqual([]);
    expect(service.isLoading()).toBe(true);
    expect(service.tabs()[0].left.rawFiles()).toEqual([]);
    expect(service.tabs()[0].left.loadedPath).toBeUndefined();
    await settleFiles();
    expect(getRemotePaths).toHaveBeenCalledTimes(2);
  });

  it('retains the failed destination without resurrecting the previous directory', async () => {
    getRemotePaths.mockResolvedValueOnce({ list: [createMinimalEntry('old.mp3')] });
    service.executeNavigate(remote, 'old', true);
    await settleFiles();
    getRemotePaths.mockRejectedValueOnce(new Error('offline'));
    service.executeNavigate(remote, 'new', true);
    await settleFiles();
    service.restoreNavigation(snapshot(service));
    service.createTab(null);
    service.switchTab(0);
    expect(service.activePath()).toBe('new');
    expect(service.rawFiles()).toEqual([]);
    expect(service.errorState()).toBe('offline');
    expect(service.isLoading()).toBe(false);
  });

  it('does not restart an in-flight listing when selection or history restoration changes', async () => {
    getRemotePaths.mockReturnValue(new Promise(vi.fn()));
    service.executeNavigate(remote, '', true);
    await settleFiles();
    service.syncSelection(new Set(['file']));
    service.restoreNavigation(snapshot(service));
    await settleFiles();
    expect(getRemotePaths).toHaveBeenCalledTimes(1);
    expect(service.selectedItems()).toEqual(new Set(['file']));
  });

  it('ignores an old A response after A -> B -> A even before signal effects run', async () => {
    let resolve!: (value: { list: ReturnType<typeof createMinimalEntry>[] }) => void;
    getRemotePaths.mockReturnValueOnce(
      new Promise(done => {
        resolve = done;
      })
    );
    service.executeNavigate(remote, 'A', true);
    await settleFiles();
    service.executeNavigate(remote, 'B', true);
    service.executeNavigate(remote, 'A', true);
    resolve({ list: [createMinimalEntry('stale.mp3')] });
    await Promise.resolve();
    await Promise.resolve();
    expect(service.rawFiles()).toEqual([]);
    expect(service.isLoading()).toBe(true);
    expect(service.tabs()[0].left.loadedPath).toBeUndefined();
  });

  it('leaves loading and errors behind when navigating to starred items', async () => {
    getRemotePaths.mockReturnValue(new Promise(vi.fn()));
    service.executeNavigate(remote, 'pending', true);
    await settleFiles();
    service.executeNavigate(null, '', true);
    expect(service.isLoading()).toBe(false);
    expect(service.rawFiles()).toEqual([]);
    expect(service.errorState()).toBeNull();
    await settleFiles();
    expect(service.isLoading()).toBe(false);
  });

  it('does not show an obsolete request error after navigating away', async () => {
    let reject!: (reason: Error) => void;
    getRemotePaths.mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail;
      })
    );
    service.executeNavigate(remote, 'old', true);
    await settleFiles();
    service.executeNavigate(remote, 'new', true);
    reject(new Error('old request failed'));
    await Promise.resolve();
    await Promise.resolve();
    expect(service.errorState()).toBeNull();
    expect(service.isLoading()).toBe(true);
    expect(TestBed.inject(NotificationService).showError).not.toHaveBeenCalled();
  });

  it('clears only the navigating split pane', async () => {
    getRemotePaths.mockResolvedValue({ list: [createMinimalEntry('file.mp3')] });
    service.executeNavigate(remote, 'left', true);
    service.toggleSplit();
    await settleFiles();
    const leftFiles = service.rawFiles();
    service.switchPane(1);
    service.executeNavigate(remote, 'right', true);
    expect(service.rawFiles()).toBe(leftFiles);
    expect(service.currentPath()).toBe('left');
    expect(service.rawFilesRight()).toEqual([]);
    expect(service.isLoadingRight()).toBe(true);
    service.restoreNavigation(snapshot(service));
    expect(service.rawFiles()).toBe(leftFiles);
    expect(service.rawFilesRight()).toEqual([]);
  });

  it('reuses the initial tab when the browser URL restores after a reload', () => {
    service.restoreNavigation({ tab: 42, pane: 0, remote: null, path: '' });
    expect(service.tabs()).toHaveLength(1);
    expect(service.tabs()[0].id).toBe(42);
    service.createTab(remote, 'second');
    expect(service.tabs().map(tab => tab.id)).toEqual([42, 43]);
  });

  it('restores the root and local history index without a stat request', async () => {
    const root = snapshot(service);
    await service.navigate(remote, 'A', true);
    getStat.mockClear();
    service.restoreNavigation(root);
    expect(service.activeRemote()).toBeNull();
    expect(service.activePath()).toBe('');
    expect(service.tabs()[0].left.historyIndex).toBe(0);
    expect(getStat).not.toHaveBeenCalled();
  });

  it('restores the original tab and split pane, including a previously closed tab', async () => {
    service.toggleSplit();
    service.switchPane(1);
    await service.navigate(remote, 'right/#文件', true);
    const target = snapshot(service);
    service.createTab(remote, 'other');
    service.closeTab(0);
    service.restoreNavigation(target);
    expect(service.navigationSnapshot()).toEqual(target);
    service.createTab(remote, 'new');
    expect(new Set(service.tabs().map(tab => tab.id)).size).toBe(service.tabs().length);
  });

  it('ignores a slow stat after Back restores a different location', async () => {
    const root = snapshot(service);
    const deferred = deferredStat();
    getStat.mockReturnValueOnce(deferred.promise);
    const pending = service.navigate(remote, 'slow', true);
    service.restoreNavigation(root);
    deferred.resolve({ item: { IsDir: true } });
    await pending;
    expect(service.navigationSnapshot()).toEqual(root);
  });

  it('does not apply a pending navigation to a newly selected tab', async () => {
    const deferred = deferredStat();
    getStat.mockReturnValueOnce(deferred.promise);
    const pending = service.navigate(remote, 'slow', true);
    service.createTab(remote, 'new-tab');
    deferred.resolve({ item: { IsDir: true } });
    await pending;
    expect(service.activePath()).toBe('new-tab');
  });

  it('keeps the latest navigation when stat requests complete out of order', async () => {
    const deferred = deferredStat();
    getStat.mockReturnValueOnce(deferred.promise);
    const pending = service.navigate(remote, 'old', true);
    await service.navigate(remote, 'new', true);
    deferred.resolve({ item: { IsDir: true } });
    await pending;
    expect(service.activePath()).toBe('new');
  });

  it('falls back to a safe root when a history remote has been removed', () => {
    service.restoreNavigation({ tab: 3, pane: 0, remote: 'deleted', path: '' });
    expect(service.activeRemote()).toBeNull();
    expect(service.activePath()).toBe('');
  });

  it('cached tabs do not collide with newly created tab ids', () => {
    service.createTab(null, '');
    const cached = service.tabs();
    const recreated = TestBed.runInInjectionContext(() => new NautilusTabService());
    recreated.tabs.set(cached);
    recreated.switchTab(0);
    recreated.createTab(null, '');
    const ids = recreated.tabs().map(tab => tab.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('allocates above unordered cached IDs and does not reuse closed tab IDs', () => {
    const tab = service.tabs()[0];
    service.tabs.set([
      { ...tab, id: 42 },
      { ...tab, id: 7 },
    ]);
    service.createTab(null);
    expect(service.tabs().map(tab => tab.id)).toEqual([42, 7, 43]);
    service.closeTab(2);
    service.createTab(null);
    expect(service.tabs().map(tab => tab.id)).toEqual([42, 7, 44]);
  });
});
