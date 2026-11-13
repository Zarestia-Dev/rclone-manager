import { Clipboard } from '@angular/cdk/clipboard';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslateService } from '@ngx-translate/core';
import {
  createDefaultRemoteFeatures,
  CompletedTransfer,
  JOB_STATUS,
  RCLONE_ACTIVITY,
  TRANSFER_STATUS,
} from '@app/types';
import { TransferOperationsService } from './transfer-operations.service';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { RemoteFileOperationsService } from 'src/app/services/remote/remote-file-operations.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { DownloadService } from 'src/app/services/operations/download.service';
import { ActivityActionItem, compareSidesOf } from './activity.utils';

describe('TransferOperationsService', () => {
  let service: TransferOperationsService;
  const features = signal({ ...createDefaultRemoteFeatures(), PublicLink: true });
  const getFeaturesSignal = vi.fn().mockReturnValue(features);
  const getPublicLink = vi.fn().mockResolvedValue({ url: 'https://example.com/file' });
  const deleteItems = vi.fn().mockResolvedValue('job');
  const transferItems = vi.fn().mockResolvedValue('job');
  const getStat = vi.fn();
  const getFsInfo = vi.fn();
  const getHashsumFile = vi.fn();
  const download = vi.fn().mockResolvedValue(undefined);
  const copy = vi.fn().mockReturnValue(true);
  const confirmModal = vi.fn().mockResolvedValue(true);
  const showSuccess = vi.fn();
  const showError = vi.fn();
  const item: ActivityActionItem = {
    name: 'folder/file.txt',
    srcFs: 'drive:photos',
    dstFs: 'backup:archive',
    status: TRANSFER_STATUS.Completed,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    features.set({ ...createDefaultRemoteFeatures(), PublicLink: true });
    copy.mockReturnValue(true);
    confirmModal.mockResolvedValue(true);
    TestBed.configureTestingModule({
      providers: [
        TransferOperationsService,
        { provide: RemoteManagementService, useValue: { getFeaturesSignal } },
        {
          provide: RemoteFileOperationsService,
          useValue: {
            getPublicLink,
            deleteItems,
            transferItems,
            getStat,
            getFsInfo,
            getHashsumFile,
          },
        },
        { provide: TranslateService, useValue: { instant: (key: string): string => key } },
        { provide: Clipboard, useValue: { copy } },
        { provide: NotificationService, useValue: { confirmModal, showSuccess, showError } },
        { provide: DownloadService, useValue: { download } },
        {
          provide: PathService,
          useValue: {
            isLocalPath: (path: string): boolean => path.startsWith('/'),
            extractName: (path: string): string | undefined => path.split('/').pop(),
            getParentPath: vi.fn().mockReturnValue('folder'),
          },
        },
      ],
    });
    service = TestBed.inject(TransferOperationsService);
  });

  it('does not request public-link metadata for unavailable or unsupported filesystem roots', () => {
    expect(service.getLinkFeatures('')).toBeUndefined();
    expect(service.getLinkFeatures('/tmp/files')).toBeUndefined();
    expect(service.getLinkFeatures('https://example.com')).toBeUndefined();
    expect(getFeaturesSignal).not.toHaveBeenCalled();
    expect(service.getLinkFeatures('drive:photos')?.PublicLink).toBe(true);
    expect(getFeaturesSignal).toHaveBeenCalledWith('drive');
  });

  it('disables unavailable sides, live destinations, and deleted files inside sync jobs', () => {
    expect(service.canAccess({ ...item, status: undefined }, 'dst', 'sync')).toBe(false);
    expect(
      service.canAccess({ ...item, status: TRANSFER_STATUS.MissingSource }, 'src', 'check')
    ).toBe(false);
    expect(
      service.canAccess({ ...item, status: TRANSFER_STATUS.MissingDestination }, 'dst', 'check')
    ).toBe(false);
    expect(service.canAccess({ ...item, what: RCLONE_ACTIVITY.Deleting }, 'src', 'sync')).toBe(
      false
    );
    expect(service.canAccess(item, 'src', 'move')).toBe(false);
    expect(service.canAccess({ ...item, status: TRANSFER_STATUS.Checked }, 'src', 'move')).toBe(
      true
    );
  });

  it('copies links through the shared HTTP-compatible clipboard and handles copy failures', async () => {
    await service.copyUrl(item, 'src', 'file-src');
    expect(getPublicLink).toHaveBeenCalledWith(
      'drive:photos',
      item.name,
      false,
      undefined,
      'dashboard'
    );
    expect(copy).toHaveBeenCalledWith('https://example.com/file');
    expect(service.pendingActions().size).toBe(0);
    copy.mockReturnValue(false);
    await service.copyUrl(item, 'src', 'file-src');
    expect(showError).toHaveBeenCalled();
    expect(service.pendingActions().size).toBe(0);
  });

  it('keeps historical activity unchanged when a later delete is only enqueued', async () => {
    const original = { ...item };
    await service.deleteFile(item, 'dst', 'file-dst');
    expect(deleteItems).toHaveBeenCalledWith(
      [{ remote: 'backup:archive', path: item.name, isDir: false }],
      'dashboard'
    );
    expect(item).toEqual(original);
    expect(service.pendingActions().size).toBe(0);
  });

  it('shares the copy request for forward retries and reverse comparison repairs', async () => {
    const transfer: CompletedTransfer = {
      ...item,
      jobid: 7,
      status: TRANSFER_STATUS.MissingSource,
      size: -1,
      bytes: 0,
      checked: false,
      error: '',
    };
    await service.copyFile(transfer);
    expect(transferItems).toHaveBeenLastCalledWith(
      [{ remote: 'drive:photos', path: item.name, name: 'file.txt', isDir: false }],
      'backup:archive',
      'folder',
      'copy',
      'dashboard',
      undefined,
      7
    );
    await service.copyFile(transfer, true);
    expect(transferItems).toHaveBeenLastCalledWith(
      [{ remote: 'backup:archive', path: item.name, name: 'file.txt', isDir: false }],
      'drive:photos',
      'folder',
      'copy',
      'dashboard',
      undefined,
      7
    );
  });

  it('prevents overlapping actions on one path while allowing another path', async () => {
    let finish!: (value: { url: string }) => void;
    getPublicLink.mockReturnValueOnce(
      new Promise<{ url: string }>(resolve => {
        finish = resolve;
      })
    );
    const pending = service.copyUrl(item, 'src', 'file-src');
    expect(service.pendingActions().get('file-src')).toBe('link');
    await service.download(item, 'src', 'file-src');
    await service.deleteFile(item, 'src', 'file-src');
    expect(download).not.toHaveBeenCalled();
    expect(confirmModal).not.toHaveBeenCalled();
    await service.download(item, 'dst', 'file-dst');
    expect(download).toHaveBeenCalledTimes(1);
    expect(service.pendingActions().get('file-src')).toBe('link');
    finish({ url: 'https://example.com/file' });
    await pending;
    expect(service.pendingActions().size).toBe(0);
  });

  it('releases pending state after cancellation or a failed request', async () => {
    confirmModal.mockResolvedValueOnce(false);
    await service.deleteFile(item, 'dst', 'file-dst');
    expect(deleteItems).not.toHaveBeenCalled();
    expect(service.pendingActions().size).toBe(0);
    download.mockRejectedValueOnce(new Error('offline'));
    await service.download(item, 'src', 'file-src');
    expect(showError).toHaveBeenCalled();
    expect(service.pendingActions().size).toBe(0);
  });

  it('blocks file actions while a repair is running', () => {
    expect(
      service.canAccess(
        {
          ...item,
          resolveState: {
            status: JOB_STATUS.Running,
            percentage: 0,
            isPreparing: true,
            bytes: 0,
            size: 0,
            speed: 0,
            eta: 0,
          },
        },
        'src',
        'copy'
      )
    ).toBe(false);
  });

  describe('resolving a check difference', () => {
    const differing = { ...item, jobid: 3, status: TRANSFER_STATUS.Partial } as CompletedTransfer;
    const sides = compareSidesOf(differing);

    it('copies from the source to the destination, or the other way round', async () => {
      await service.resolveCheck(differing, 'toDestination');
      expect(transferItems).toHaveBeenLastCalledWith(
        [expect.objectContaining({ remote: 'drive:photos', path: 'folder/file.txt' })],
        'backup:archive',
        'folder',
        'copy',
        'dashboard',
        undefined,
        3
      );
      await service.resolveCheck(differing, 'toSource');
      expect(transferItems).toHaveBeenLastCalledWith(
        [expect.objectContaining({ remote: 'backup:archive', path: 'folder/file.txt' })],
        'drive:photos',
        'folder',
        'copy',
        'dashboard',
        undefined,
        3
      );
    });

    it('reads the size and modification time of both sides from the remotes', async () => {
      getStat.mockImplementation(async (fs: string) => ({
        item:
          fs === 'drive:photos'
            ? { Size: 12, ModTime: '2026-11-07T10:00:00Z' }
            : { Size: 20, ModTime: '' },
      }));
      expect(await service.getVersionsAt(sides.src, sides.dst)).toEqual({
        src: { size: 12, modTime: '2026-11-07T10:00:00Z' },
        dst: { size: 20, modTime: null },
      });
      expect(getStat).toHaveBeenCalledWith(
        'backup:archive',
        'folder/file.txt',
        { filesOnly: true },
        'dashboard'
      );
    });

    it('reports a side whose file is gone, or that has no root, as missing', async () => {
      getStat.mockResolvedValueOnce({ item: null });
      getStat.mockResolvedValueOnce({ item: { Size: 3, ModTime: '2026-01-01T00:00:00Z' } });
      const versions = await service.getVersionsAt(sides.src, sides.dst);
      expect(versions.src).toBeNull();
      expect(versions.dst?.size).toBe(3);
      expect(
        (await service.getVersionsAt(sides.src, { fs: '', path: differing.name })).dst
      ).toBeNull();
    });

    it('hashes both files with the first type the two remotes share', async () => {
      getFsInfo.mockImplementation(async (fs: string) => ({
        Hashes: fs === 'drive:photos' ? ['sha1', 'md5', 'crc32'] : ['md5', 'crc32'],
      }));
      getHashsumFile.mockImplementation(async (_fs: string, _path: string, type: string) => ({
        hash: 'abc',
        hashType: type,
      }));
      expect(await service.compareChecksumsAt(sides.src, sides.dst)).toEqual({
        hashType: 'md5',
        src: 'abc',
        dst: 'abc',
        match: true,
      });
      getHashsumFile.mockResolvedValueOnce({ hash: 'abc', hashType: 'md5' });
      getHashsumFile.mockResolvedValueOnce({ hash: 'def', hashType: 'md5' });
      expect((await service.compareChecksumsAt(sides.src, sides.dst))?.match).toBe(false);
    });

    it('does not compare when the remotes share no hash type or a root is missing', async () => {
      getFsInfo.mockResolvedValueOnce({ Hashes: ['sha1'] });
      getFsInfo.mockResolvedValueOnce({ Hashes: ['md5'] });
      expect(await service.compareChecksumsAt(sides.src, sides.dst)).toBeNull();
      expect(getHashsumFile).not.toHaveBeenCalled();
      expect(
        await service.compareChecksumsAt({ fs: '', path: differing.name }, sides.dst)
      ).toBeNull();
    });
  });
});
