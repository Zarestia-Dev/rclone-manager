import { TestBed } from '@angular/core/testing';
import { FormControl } from '@angular/forms';
import { createMinimalEntry, Entry } from '@app/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PathSelectionService } from './path-selection.service';
import { RemoteFileOperationsService } from './remote-file-operations.service';
import { RemoteManagementService } from './remote-management.service';
import { PathService } from '../infrastructure/platform/path.service';
import { BackendService } from '../infrastructure/system/backend.service';

describe('PathSelectionService input lifecycle', () => {
  const getPaths = vi.fn();
  const getLocalDrives = vi.fn();
  const isWindows = vi.fn();
  let service: PathSelectionService;
  beforeEach(() => {
    vi.useFakeTimers();
    getPaths.mockReset().mockResolvedValue({ list: [] });
    getLocalDrives.mockReset().mockResolvedValue([{ name: 'C:\\' }, { name: 'D:\\' }]);
    isWindows.mockReset().mockReturnValue(false);
    TestBed.configureTestingModule({
      providers: [
        PathSelectionService,
        { provide: RemoteFileOperationsService, useValue: { getRemotePaths: getPaths } },
        { provide: RemoteManagementService, useValue: { getLocalDrives } },
        { provide: BackendService, useValue: { isWindows } },
        PathService,
      ],
    });
    service = TestBed.inject(PathSelectionService);
    service.registerField('source-0', 'drive');
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('selects a Windows drive and folders using the correct root and relative paths', async () => {
    isWindows.mockReturnValue(true);
    getPaths
      .mockResolvedValueOnce({ list: [{ ...createMinimalEntry('Users'), IsDir: true }] })
      .mockResolvedValueOnce({ list: [{ ...createMinimalEntry('hakan'), IsDir: true }] });
    const control = new FormControl('');
    service.registerField('dest-0', '');
    service.triggerLoad('dest-0', '', '');
    await vi.advanceTimersByTimeAsync(0);

    service.selectEntry('dest-0', 'C:\\', control);
    await vi.advanceTimersByTimeAsync(0);
    expect(control.value).toBe('C:\\');
    expect(getPaths).toHaveBeenLastCalledWith('C:\\', '', {}, 'filemanager');

    service.selectEntry('dest-0', 'Users', control);
    await vi.advanceTimersByTimeAsync(0);
    expect(control.value).toBe('C:\\Users');
    expect(getPaths).toHaveBeenLastCalledWith('C:\\', 'Users', {}, 'filemanager');

    service.selectEntry('dest-0', 'hakan', control);
    await vi.advanceTimersByTimeAsync(0);
    expect(control.value).toBe('C:\\Users\\hakan');
    expect(getPaths).toHaveBeenLastCalledWith('C:\\', 'Users/hakan', {}, 'filemanager');

    service.navigateUp('dest-0', control);
    await vi.advanceTimersByTimeAsync(0);
    service.navigateUp('dest-0', control);
    await vi.advanceTimersByTimeAsync(0);
    expect(control.value).toBe('C:\\');
    expect(getPaths).toHaveBeenLastCalledWith('C:/', '', {}, 'filemanager');
    service.navigateUp('dest-0', control);
    await vi.advanceTimersByTimeAsync(0);
    expect(control.value).toBe('');
    expect(getLocalDrives).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('keeps remote selections relative on Windows=%s', async windows => {
    isWindows.mockReturnValue(windows);
    getPaths.mockResolvedValueOnce({
      list: [{ ...createMinimalEntry('Arşiv 2026'), IsDir: true }],
    });
    const control = new FormControl('');
    service.triggerLoad('source-0', 'drive', '');
    await vi.advanceTimersByTimeAsync(0);
    service.selectEntry('source-0', 'Arşiv 2026', control);
    await vi.advanceTimersByTimeAsync(0);
    expect(control.value).toBe('Arşiv 2026');
    expect(getPaths).toHaveBeenLastCalledWith('drive:', 'Arşiv 2026', {}, 'filemanager');
  });

  it('preserves a Windows network share through selection and parent navigation', async () => {
    isWindows.mockReturnValue(true);
    getPaths.mockResolvedValueOnce({ list: [{ ...createMinimalEntry('Arşiv'), IsDir: true }] });
    const control = new FormControl('\\\\server\\share');
    service.registerField('dest-0', '');
    service.triggerLoad('dest-0', '', control.value ?? '');
    await vi.advanceTimersByTimeAsync(0);
    service.selectEntry('dest-0', 'Arşiv', control);
    await vi.advanceTimersByTimeAsync(0);
    expect(control.value).toBe('\\\\server\\share\\Arşiv');
    expect(getPaths).toHaveBeenLastCalledWith('\\\\server\\share\\Arşiv', '', {}, 'filemanager');
    service.navigateUp('dest-0', control);
    await vi.advanceTimersByTimeAsync(0);
    expect(control.value).toBe('\\\\server\\share');
    service.navigateUp('dest-0', control);
    await vi.advanceTimersByTimeAsync(0);
    expect(control.value).toBe('');
    expect(getLocalDrives).toHaveBeenCalledTimes(1);
  });

  it('preserves POSIX roots when selecting the first local folder', async () => {
    getPaths.mockResolvedValueOnce({ list: [{ ...createMinimalEntry('home'), IsDir: true }] });
    const control = new FormControl('');
    service.registerField('dest-0', '');
    service.triggerLoad('dest-0', '', '');
    await vi.advanceTimersByTimeAsync(0);
    service.selectEntry('dest-0', 'home', control);
    await vi.advanceTimersByTimeAsync(0);
    expect(control.value).toBe('/home');
    expect(getPaths).toHaveBeenLastCalledWith('/', 'home', {}, 'filemanager');
  });

  it('keeps drive-relative Windows input relative to the drive working directory', async () => {
    isWindows.mockReturnValue(true);
    getPaths.mockResolvedValue({ list: [{ ...createMinimalEntry('child'), IsDir: true }] });
    const control = new FormControl('D:folder');
    service.registerField('dest-0', '');
    service.triggerLoad('dest-0', '', control.value ?? '');
    await vi.advanceTimersByTimeAsync(0);
    expect(getPaths).toHaveBeenLastCalledWith('D:', 'folder', {}, 'filemanager');
    service.selectEntry('dest-0', 'child', control);
    await vi.advanceTimersByTimeAsync(0);
    expect(control.value).toBe('D:folder\\child');
    expect(getPaths).toHaveBeenLastCalledWith('D:', 'folder/child', {}, 'filemanager');
  });

  it('preserves POSIX backslashes when listing, selecting, and navigating up', async () => {
    getPaths.mockResolvedValue({ list: [{ ...createMinimalEntry('c\\d'), IsDir: true }] });
    const control = new FormControl('/home/a\\b');
    service.registerField('dest-0', '');
    service.triggerLoad('dest-0', '', control.value ?? '');
    await vi.advanceTimersByTimeAsync(0);
    expect(getPaths).toHaveBeenLastCalledWith('/', 'home/a\\b', {}, 'filemanager');
    service.selectEntry('dest-0', 'c\\d', control);
    await vi.advanceTimersByTimeAsync(0);
    expect(control.value).toBe('/home/a\\b/c\\d');
    expect(getPaths).toHaveBeenLastCalledWith('/', 'home/a\\b/c\\d', {}, 'filemanager');
    service.navigateUp('dest-0', control);
    await vi.advanceTimersByTimeAsync(0);
    expect(control.value).toBe('/home/a\\b');
  });

  it.each([false, true])(
    'preserves literal backslashes in cloud paths on Windows=%s',
    async windows => {
      isWindows.mockReturnValue(windows);
      getPaths.mockResolvedValue({ list: [{ ...createMinimalEntry('a\\b'), IsDir: true }] });
      const control = new FormControl('photos');
      service.triggerLoad('source-0', 'drive', 'photos');
      await vi.advanceTimersByTimeAsync(0);
      service.selectEntry('source-0', 'a\\b', control);
      await vi.advanceTimersByTimeAsync(0);
      expect(control.value).toBe('photos/a\\b');
      expect(getPaths).toHaveBeenLastCalledWith('drive:', 'photos/a\\b', {}, 'filemanager');
      service.navigateUp('source-0', control);
      await vi.advanceTimersByTimeAsync(0);
      expect(control.value).toBe('photos');
    }
  );

  it('uses the requested filesystem after a field switches between local and remote paths', async () => {
    isWindows.mockReturnValue(true);
    getPaths.mockResolvedValue({ list: [{ ...createMinimalEntry('child'), IsDir: true }] });
    const control = new FormControl('');
    const state = service.registerField('source-0', 'drive');
    service.triggerLoad('source-0', '', '');
    await vi.advanceTimersByTimeAsync(0);
    expect(state().remoteName).toBe('');
    service.selectEntry('source-0', 'C:\\', control);
    await vi.advanceTimersByTimeAsync(0);
    expect(control.value).toBe('C:\\');
    expect(getPaths).toHaveBeenLastCalledWith('C:\\', '', {}, 'filemanager');

    service.triggerLoad('source-0', 'backup', 'photos');
    await vi.advanceTimersByTimeAsync(0);
    expect(state().remoteName).toBe('backup');
    service.selectEntry('source-0', 'child', control);
    await vi.advanceTimersByTimeAsync(0);
    expect(control.value).toBe('photos/child');
    expect(getPaths).toHaveBeenLastCalledWith('backup:', 'photos/child', {}, 'filemanager');
  });

  it('keeps remote parent navigation POSIX on a Windows engine', async () => {
    isWindows.mockReturnValue(true);
    const control = new FormControl('C:/folder');
    service.triggerLoad('source-0', 'drive', 'C:/folder');
    await vi.advanceTimersByTimeAsync(0);
    service.navigateUp('source-0', control);
    await vi.advanceTimersByTimeAsync(0);
    expect(control.value).toBe('C:');
    expect(getPaths).toHaveBeenLastCalledWith('drive:', 'C:', {}, 'filemanager');
  });

  it('selects a file at a remote root without issuing a directory listing for the file', async () => {
    getPaths.mockResolvedValueOnce({ list: [createMinimalEntry('Özet 2026.txt')] });
    const control = new FormControl('');
    service.triggerLoad('source-0', 'drive', '');
    await vi.advanceTimersByTimeAsync(0);
    service.selectEntry('source-0', 'Özet 2026.txt', control);
    expect(control.value).toBe('Özet 2026.txt');
    expect(getPaths).toHaveBeenCalledTimes(1);
    service.selectEntry('source-0', 'missing.txt', control);
    expect(control.value).toBe('Özet 2026.txt');
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
