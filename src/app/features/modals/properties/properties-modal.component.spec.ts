import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { PropertiesModalComponent } from './properties-modal.component';
import { RemoteFileOperationsService } from '../../../services/remote/remote-file-operations.service';
import { NautilusService } from '../../../services/ui/nautilus.service';
import { RemoteFacadeService } from '../../../services/facade/remote-facade.service';
import { IconService } from '../../../services/ui/icon.service';
import { RemoteManagementService } from '../../../services/remote/remote-management.service';
import { PathService } from '../../../services/infrastructure/platform/path.service';
import { JobManagementService } from '../../../services/operations/job-management.service';
import { Entry } from '@app/types';

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
    getHashsumFile: vi.fn().mockResolvedValue({ hashsum: ['abc123hash'], hashType: 'md5' }),
  };

  const mockNautilusService = {
    isSaved: vi.fn().mockReturnValue(false),
    toggleItem: vi.fn(),
  };

  const mockRemoteFacadeService = {
    getCachedOrFetchDiskUsage: vi.fn().mockResolvedValue({ total: 10000, used: 4000, free: 6000 }),
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
    joinPath: vi.fn().mockImplementation((...parts: string[]) => parts.filter(Boolean).join('/')),
    splitLocalForStat: vi.fn().mockReturnValue({ root: '/', relative: 'folder/test-file.pdf' }),
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
        { provide: RemoteFacadeService, useValue: mockRemoteFacadeService },
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
