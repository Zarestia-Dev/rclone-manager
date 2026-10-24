import { TestBed } from '@angular/core/testing';
import { Entry } from '@app/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PathSelectionService } from './path-selection.service';
import { RemoteFileOperationsService } from './remote-file-operations.service';
import { RemoteManagementService } from './remote-management.service';
import { PathService } from '../infrastructure/platform/path.service';
import { BackendService } from '../infrastructure/system/backend.service';

describe('PathSelectionService input lifecycle', () => {
  const getPaths = vi.fn();
  let service: PathSelectionService;
  beforeEach(() => {
    vi.useFakeTimers();
    getPaths.mockReset().mockResolvedValue({ list: [] });
    TestBed.configureTestingModule({
      providers: [
        PathSelectionService,
        { provide: RemoteFileOperationsService, useValue: { getRemotePaths: getPaths } },
        { provide: RemoteManagementService, useValue: {} },
        { provide: BackendService, useValue: { isWindows: (): boolean => false } },
        {
          provide: PathService,
          useValue: {
            getPrimaryPath: (path: string): string => path,
            normalizeRemoteForRclone: (remote: string): string => `${remote}:`,
          },
        },
      ],
    });
    service = TestBed.inject(PathSelectionService);
    service.registerField('source-0', 'drive');
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('debounces input and sends only the final typed path', async () => {
    service.updateInput('source-0', 'p');
    service.updateInput('source-0', 'photos');
    expect(getPaths).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(getPaths).toHaveBeenCalledExactlyOnceWith('drive:', 'photos', {}, 'filemanager');
  });

  it('loads immediately when a menu opens and cancels pending typing work', async () => {
    service.updateInput('source-0', 'old');
    service.triggerLoad('source-0', 'drive', 'current');
    await vi.advanceTimersByTimeAsync(250);
    expect(getPaths).toHaveBeenCalledExactlyOnceWith('drive:', 'current', {}, 'filemanager');
  });

  it('ignores an old response as soon as newer input arrives', async () => {
    let resolveOld: (value: { list: Entry[] }) => void = () => {
      /* assigned below */
    };
    getPaths.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveOld = resolve;
        })
    );
    const state = service.registerField('source-0', 'drive');
    service.triggerLoad('source-0', 'drive', 'old');
    service.updateInput('source-0', 'new');
    resolveOld({ list: [{ Name: 'stale-result' } as Entry] });
    await Promise.resolve();
    expect(state().currentPath).toBe('old');
    expect(state().options).toEqual([]);
    await vi.advanceTimersByTimeAsync(250);
    expect(state().currentPath).toBe('new');
  });

  it('cancels pending input when a field is reset or removed', async () => {
    service.updateInput('source-0', 'old');
    service.resetPath('source-0');
    await vi.advanceTimersByTimeAsync(250);
    service.updateInput('source-0', 'new');
    service.unregisterField('source-0');
    await vi.advanceTimersByTimeAsync(250);
    expect(getPaths).not.toHaveBeenCalled();
  });
  it('coalesces queued input behind one active transport per field', async () => {
    let finish!: (value: { list: Entry[] }) => void;
    getPaths.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const state = service.registerField('source-0', 'drive');
    service.triggerLoad('source-0', 'drive', 'first');
    service.updateInput('source-0', 'second');
    await vi.advanceTimersByTimeAsync(250);
    service.updateInput('source-0', 'latest');
    await vi.advanceTimersByTimeAsync(250);
    expect(getPaths).toHaveBeenCalledTimes(1);
    finish({ list: [{ Name: 'stale' } as Entry] });
    await vi.advanceTimersByTimeAsync(0);
    expect(getPaths).toHaveBeenCalledTimes(2);
    expect(getPaths).toHaveBeenLastCalledWith('drive:', 'latest', {}, 'filemanager');
    expect(state().options).toEqual([]);
  });

  it('discards queued requests when their field is removed', async () => {
    let finish!: (value: { list: Entry[] }) => void;
    getPaths.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    service.triggerLoad('source-0', 'drive', 'first');
    service.triggerLoad('source-0', 'drive', 'queued');
    service.unregisterField('source-0');
    finish({ list: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(getPaths).toHaveBeenCalledTimes(1);
  });
});
