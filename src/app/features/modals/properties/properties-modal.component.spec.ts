import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { PropertiesModalComponent } from './properties-modal.component';
import { RemoteFileOperationsService } from '../../../services/remote/remote-file-operations.service';
import { NautilusService } from '../../../services/ui/nautilus.service';
import { RemoteDiskUsageService } from '../../../services/remote/remote-disk-usage.service';
import { IconService } from '../../../services/ui/icon.service';
import { RemoteManagementService } from '../../../services/remote/remote-management.service';
import { PathService } from '../../../services/infrastructure/platform/path.service';
import { JobManagementService } from '../../../services/operations/job-management.service';
import { BackendService } from '../../../services/infrastructure/system/backend.service';
import { createDefaultRemoteFeatures, createMinimalEntry, Entry } from '@app/types';

describe('PropertiesModalComponent', () => {
  let fixture: ComponentFixture<PropertiesModalComponent>;
  let component: PropertiesModalComponent;

  const mockDialogRef = {
    close: vi.fn(),
  };

  const mockRemoteOps = {
    getSize: vi.fn().mockResolvedValue({ count: 5, bytes: 5000 }),
    getDiskUsage: vi.fn().mockResolvedValue({ total: 10000, used: 4000, free: 6000 }),
    getStat: vi.fn().mockResolvedValue({
      item: {
        ID: 'test-id-123',
        Name: 'test-file.pdf',
        Path: 'folder/test-file.pdf',
        IsDir: false,
        Size: 1024,
        ModTime: '2024-10-14T14:15:27.922Z',
        MimeType: 'application/pdf',
        Metadata: {
          btime: '2024-10-10T10:00:00Z',
          'drive-owners': 'Alice Wonderland',
          'sharing-user-name': 'Bob Builder',
          'shared-with-me': '2024-10-12T12:00:00Z',
          tier: 'STANDARD',
          mode: '100644',
          'drive-id': 'drive-xyz-123',
        },
      } as Entry,
    }),
    getHashsumFile: vi.fn().mockResolvedValue({ hash: 'abc123hash', hashType: 'md5' }),
  };

  const mockNautilusService = {
    isSaved: vi.fn().mockReturnValue(false),
    toggleItem: vi.fn(),
  };

  const mockRemoteDiskUsageService = {
    load: vi.fn().mockResolvedValue({ total: 10000, used: 4000, free: 6000 }),
  };

  const mockIconService = {
    getIconForEntry: vi.fn().mockReturnValue('file-text'),
    getIconName: vi.fn().mockReturnValue('file-text'),
  };

  const mockRemoteService = {
    getFeatures: vi.fn().mockResolvedValue({ Hashes: ['md5'] }),
  };

  const mockPathService = {
    getFullDisplayPath: vi.fn().mockReturnValue('Google Drive:/folder/test-file.pdf'),
    normalizeRemoteForRclone: vi.fn().mockReturnValue('Google Drive:'),
    normalizeRemoteName: vi.fn().mockReturnValue('Google Drive'),
  };

  const mockJobService = {
    stopJobsByGroup: vi.fn().mockResolvedValue(undefined),
  };

  const mockData = {
    remoteName: 'Google Drive',
    path: 'folder/test-file.pdf',
    isLocal: false,
    remoteType: 'drive',
    item: {
      ID: 'test-id-123',
      Name: 'test-file.pdf',
      Path: 'folder/test-file.pdf',
      IsDir: false,
      Size: 1024,
      ModTime: '2024-10-14T14:15:27.922Z',
    } as Entry,
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    await TestBed.configureTestingModule({
      imports: [PropertiesModalComponent],
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: mockDialogRef },
        { provide: MAT_DIALOG_DATA, useValue: mockData },
        { provide: RemoteFileOperationsService, useValue: mockRemoteOps },
        { provide: NautilusService, useValue: mockNautilusService },
        { provide: RemoteDiskUsageService, useValue: mockRemoteDiskUsageService },
        { provide: IconService, useValue: mockIconService },
        { provide: RemoteManagementService, useValue: mockRemoteService },
        { provide: PathService, useValue: mockPathService },
        { provide: JobManagementService, useValue: mockJobService },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(PropertiesModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create component and call getStat with metadata: true', async () => {
    expect(component).toBeTruthy();
    expect(mockRemoteOps.getStat).toHaveBeenCalledWith(
      'Google Drive:',
      'folder/test-file.pdf',
      { metadata: true },
      'filemanager',
      expect.any(String)
    );
  });

  it('should compute rich metadata fields from getStat response', async () => {
    // Wait for promise resolution
    await fixture.whenStable();

    const share = component.shareInfo();
    expect(share.isShared).toBe(true);
    expect(share.kind).toBe('metadata-shared');

    const entries = component.metadataEntries();
    expect(entries).toContainEqual({ key: 'drive-id', value: 'drive-xyz-123' });
    // Shows all raw fields in overlay without exclusion
    expect(entries).toContainEqual({ key: 'btime', value: '2024-10-10T10:00:00Z' });
    expect(entries).toContainEqual({ key: 'tier', value: 'STANDARD' });
    expect(entries).toContainEqual({ key: 'mode', value: '100644' });
    expect(component.loadingMetadata()).toBe(false);
  });

  it('should toggle metadata overlay and close it on escape or back', async () => {
    expect(component.showMetadataOverlay()).toBe(false);

    component.showMetadataOverlay.set(true);
    expect(component.showMetadataOverlay()).toBe(true);

    // Calling close while overlay is open should close the overlay first without closing dialog
    component.close();
    expect(component.showMetadataOverlay()).toBe(false);
    expect(mockDialogRef.close).not.toHaveBeenCalled();

    // Calling close while overlay is closed should close the dialog
    component.close();
    expect(mockDialogRef.close).toHaveBeenCalledTimes(1);
  });
});

describe('PropertiesModalComponent filesystem paths', () => {
  let data: PropertiesModalComponent['data'];
  const isWindows = signal(true);
  const remoteOps = {
    getStat: vi.fn(),
    getSize: vi.fn(),
    getDiskUsage: vi.fn(),
    getHashsumFile: vi.fn(),
    getHashsum: vi.fn(),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    isWindows.set(true);
    data = {
      remoteName: 'C:\\',
      path: 'Windows/win.ini',
      isLocal: true,
      item: createMinimalEntry('Windows/win.ini'),
      features: { ...createDefaultRemoteFeatures(true), Hashes: ['md5'] },
    };
    remoteOps.getStat.mockImplementation(async () => ({ item: data.item }));
    remoteOps.getSize.mockResolvedValue({ count: 1, bytes: 100 });
    remoteOps.getDiskUsage.mockResolvedValue({ total: 10000, used: 4000, free: 6000 });
    remoteOps.getHashsumFile.mockResolvedValue({ hash: 'abc123', hashType: 'md5' });
    remoteOps.getHashsum.mockResolvedValue({ hashsum: ['abc123  win.ini'], hashType: 'md5' });
    TestBed.configureTestingModule({
      imports: [PropertiesModalComponent],
      providers: [
        provideTranslateService(),
        PathService,
        { provide: BackendService, useValue: { isWindows } },
        { provide: MatDialogRef, useValue: { close: vi.fn() } },
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: RemoteFileOperationsService, useValue: remoteOps },
        {
          provide: NautilusService,
          useValue: { isSaved: vi.fn().mockReturnValue(false), toggleItem: vi.fn() },
        },
        {
          provide: RemoteDiskUsageService,
          useValue: { load: vi.fn().mockResolvedValue(undefined) },
        },
        { provide: IconService, useValue: {} },
        { provide: RemoteManagementService, useValue: {} },
        {
          provide: JobManagementService,
          useValue: { stopJobsByGroup: vi.fn().mockResolvedValue(undefined) },
        },
      ],
    }).overrideComponent(PropertiesModalComponent, { set: { template: '', imports: [] } });
    TestBed.inject(PathService).setRemoteNames(['drive']);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  async function openProperties(): Promise<PropertiesModalComponent> {
    const fixture = TestBed.createComponent(PropertiesModalComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    await vi.waitFor(() => expect(fixture.componentInstance.loadingDiskUsage()).toBe(false));
    return fixture.componentInstance;
  }

  it.each([
    ['C:\\Users\\hakan', 'ntuser.ini'],
    ['C:\\', 'Users/hakan/ntuser.ini'],
    ['C:\\', 'Users\\hakan\\ntuser.ini'],
    ['D:/', 'Arşiv 2026/旅行 & #1'],
    ['\\\\server\\share', 'docs/file.txt'],
    ['/', 'home/hakan/file.txt'],
  ])('passes the original file path to the storage API: %s %s', async (root, path) => {
    isWindows.set(root !== '/');
    data.remoteName = root;
    data.path = path;
    data.item = createMinimalEntry(path);
    const component = await openProperties();
    expect(remoteOps.getDiskUsage).toHaveBeenCalledExactlyOnceWith(
      root,
      path,
      'filemanager',
      expect.any(String)
    );
    expect(component.diskUsage()).toEqual({ total: 10000, used: 4000, free: 6000 });
    expect(component.loadingDiskUsage()).toBe(false);
    expect(remoteOps.getHashsumFile).toHaveBeenCalledWith(
      root,
      path,
      'md5',
      'filemanager',
      expect.any(String)
    );
    expect(remoteOps.getStat).toHaveBeenCalledWith(
      root,
      path,
      { metadata: true },
      'filemanager',
      expect.any(String)
    );
    expect(component.fileHashes()).toEqual({ md5: 'abc123' });
    expect(component.isHashLoading('md5')).toBe(false);
  });

  it.each(['', 'folder.with.dots', 'nested/mounted-volume'])(
    'requests storage for the selected directory itself: %s',
    async path => {
      data.path = path;
      data.item = { ...createMinimalEntry(path), IsDir: true };
      await openProperties();
      expect(remoteOps.getDiskUsage).toHaveBeenCalledExactlyOnceWith(
        'C:\\',
        path,
        'filemanager',
        expect.any(String)
      );
    }
  );

  it('loads storage immediately and waits for metadata before automatically hashing a file', async () => {
    let finishStat!: (result: { item: Entry }) => void;
    remoteOps.getStat.mockReturnValueOnce(
      new Promise(resolve => {
        finishStat = resolve;
      })
    );
    data.item = null;
    const fixture = TestBed.createComponent(PropertiesModalComponent);
    fixture.detectChanges();
    expect(remoteOps.getDiskUsage).toHaveBeenCalledExactlyOnceWith(
      'C:\\',
      'Windows/win.ini',
      'filemanager',
      expect.any(String)
    );
    expect(remoteOps.getHashsumFile).not.toHaveBeenCalled();
    expect(remoteOps.getSize).not.toHaveBeenCalled();
    finishStat({ item: createMinimalEntry('Windows/win.ini') });
    await fixture.whenStable();
    await vi.waitFor(() =>
      expect(remoteOps.getHashsumFile).toHaveBeenCalledExactlyOnceWith(
        'C:\\',
        'Windows/win.ini',
        'md5',
        'filemanager',
        expect.any(String)
      )
    );
    expect(fixture.componentInstance.loadingDiskUsage()).toBe(false);
    expect(remoteOps.getSize).not.toHaveBeenCalled();
    expect(fixture.componentInstance.size()).toMatchObject({ count: 1 });
  });

  it('does not change the storage target when the metadata request fails', async () => {
    data.item = null;
    remoteOps.getStat.mockRejectedValueOnce(new Error('stat unavailable'));
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const component = await openProperties();
    expect(remoteOps.getDiskUsage).toHaveBeenCalledWith(
      'C:\\',
      'Windows/win.ini',
      'filemanager',
      expect.any(String)
    );
    expect(component.diskUsage()).toEqual({ total: 10000, used: 4000, free: 6000 });
    expect(remoteOps.getSize).not.toHaveBeenCalled();
  });

  it('loads directory size after metadata identifies an initially unknown item', async () => {
    data.item = null;
    data.path = 'Arşiv';
    remoteOps.getStat.mockResolvedValueOnce({
      item: { ...createMinimalEntry('Arşiv'), IsDir: true },
    });
    const component = await openProperties();
    expect(remoteOps.getSize).toHaveBeenCalledExactlyOnceWith(
      'C:\\',
      'Arşiv',
      'filemanager',
      expect.any(String)
    );
    expect(component.size()).toEqual({ count: 1, bytes: 100 });
    expect(component.loadingSize()).toBe(false);
    expect(remoteOps.getHashsumFile).not.toHaveBeenCalled();
  });

  it('does not start an automatic hash request after the properties dialog closes', async () => {
    let finishStat!: (result: { item: Entry }) => void;
    remoteOps.getStat.mockReturnValueOnce(
      new Promise(resolve => {
        finishStat = resolve;
      })
    );
    data.item = null;
    const fixture = TestBed.createComponent(PropertiesModalComponent);
    fixture.detectChanges();
    fixture.destroy();
    finishStat({ item: createMinimalEntry('Windows/win.ini') });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(remoteOps.getDiskUsage).toHaveBeenCalledTimes(1);
    expect(remoteOps.getHashsumFile).not.toHaveBeenCalled();
    expect(remoteOps.getSize).not.toHaveBeenCalled();
  });

  it('clears the storage loading state when the daemon rejects the storage query', async () => {
    remoteOps.getDiskUsage.mockRejectedValueOnce(new Error('storage unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const component = await openProperties();
    expect(component.diskUsage()).toBeNull();
    expect(component.loadingDiskUsage()).toBe(false);
  });

  it('uses cached cloud capacity instead of the local storage query', async () => {
    data.isLocal = false;
    data.remoteName = 'drive';
    const capacity = TestBed.inject(RemoteDiskUsageService);
    const usage = { total: 10000, used: 4000, free: 6000 };
    vi.mocked(capacity.load).mockResolvedValueOnce(usage);
    const component = await openProperties();
    expect(capacity.load).toHaveBeenCalledWith('drive', {
      source: 'filemanager',
      group: expect.any(String),
    });
    expect(remoteOps.getDiskUsage).not.toHaveBeenCalled();
    expect(component.diskUsage()).toEqual(usage);
  });

  it('retains cloud filesystem names and relative paths on a Windows backend', async () => {
    data.isLocal = false;
    data.remoteName = 'drive';
    data.path = 'photos/旅行.txt';
    await openProperties();
    expect(remoteOps.getHashsumFile).toHaveBeenCalledWith(
      'drive:',
      'photos/旅行.txt',
      'md5',
      'filemanager',
      expect.any(String)
    );
  });

  it.each(['', 'Arşiv 2026'])(
    'uses the same root and relative folder for size and bulk hash: %s',
    async path => {
      data.remoteName = 'C:\\Users\\hakan';
      data.path = path;
      data.item = { ...createMinimalEntry(path, 'hakan'), IsDir: true };
      const component = await openProperties();
      await component.calculateBulkHash('md5');
      expect(remoteOps.getSize).toHaveBeenCalledWith(
        'C:\\Users\\hakan',
        path,
        'filemanager',
        expect.any(String)
      );
      expect(remoteOps.getHashsum).toHaveBeenCalledExactlyOnceWith(
        'C:\\Users\\hakan',
        path,
        'md5',
        'filemanager',
        expect.any(String)
      );
      expect(remoteOps.getHashsumFile).not.toHaveBeenCalled();
      expect(component.bulkHashResult()).toBe('abc123  win.ini');
    }
  );

  it('supports a missing initial item when opening a local root', async () => {
    data.path = '';
    data.item = null;
    const component = await openProperties();
    expect(component.hashPath).toBe('');
    expect(remoteOps.getStat).toHaveBeenCalledWith(
      'C:\\',
      '',
      { metadata: true },
      'filemanager',
      expect.any(String)
    );
  });

  it.each(['item path', 'filename'])(
    'falls back to the local %s when no dialog path was provided',
    async fallback => {
      data.path = '';
      data.item = createMinimalEntry(fallback === 'item path' ? 'Windows/win.ini' : '', 'win.ini');
      const component = await openProperties();
      expect(component.hashPath).toBe(fallback === 'item path' ? 'Windows/win.ini' : 'win.ini');
      expect(component.displayLocation).toBe(
        fallback === 'item path' ? 'C:\\Windows\\win.ini' : 'C:\\win.ini'
      );
      expect(component.isStarred()).toBe(false);
      expect(TestBed.inject(NautilusService).isSaved).toHaveBeenCalledWith(
        'starred',
        'C:\\',
        component.hashPath
      );
      component.toggleStar();
      expect(TestBed.inject(NautilusService).toggleItem).toHaveBeenCalledWith(
        'starred',
        expect.objectContaining({ entry: expect.objectContaining({ Path: component.hashPath }) })
      );
    }
  );

  it('clears a failed hash request so the same file can be retried', async () => {
    remoteOps.getHashsumFile.mockRejectedValueOnce(new Error('backendErrors.remote.notFound'));
    const component = await openProperties();
    expect(component.isHashLoading('md5')).toBe(false);
    expect(component.fileHashes()).toEqual({});
    await component.calculateHash('md5');
    expect(component.fileHashes()).toEqual({ md5: 'abc123' });
    expect(remoteOps.getHashsumFile).toHaveBeenCalledTimes(2);
    await component.calculateHash('md5');
    expect(remoteOps.getHashsumFile).toHaveBeenCalledTimes(2);
  });
});
