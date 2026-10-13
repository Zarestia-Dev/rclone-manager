import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { signal } from '@angular/core';
import { RemoteAboutModalComponent } from './remote-about-modal.component';
import { RemoteFileOperationsService } from 'src/app/services/remote/remote-file-operations.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { RcloneValueMapperService } from 'src/app/services/remote/rclone-value-mapper.service';
import { FsInfo } from '@app/types';

describe('RemoteAboutModalComponent', () => {
  let fixture: ComponentFixture<RemoteAboutModalComponent>;
  let component: RemoteAboutModalComponent;
  let dialogRefSpy: { close: ReturnType<typeof vi.fn> };
  let remoteOpsSpy: { getSize: ReturnType<typeof vi.fn> };
  let remoteFacadeSpy: {
    diskUsageSignal: ReturnType<typeof vi.fn>;
    getCachedOrFetchDiskUsage: ReturnType<typeof vi.fn>;
  };
  let remoteManagementSpy: {
    clearCache: ReturnType<typeof vi.fn>;
    getFsInfo: ReturnType<typeof vi.fn>;
  };
  let jobManagementSpy: {
    stopJobsByGroup: ReturnType<typeof vi.fn>;
  };
  let mapperSpy: {
    nanosecondsToDuration: ReturnType<typeof vi.fn>;
  };

  const mockFsInfo: FsInfo = {
    Root: 'drive:/data',
    Precision: 1000000,
    Hashes: ['md5', 'sha1'],
    Features: {
      About: true,
      BucketBased: false,
      Copy: true,
      IsLocal: false,
    },
    MetadataInfo: {
      System: {
        mtime: { Help: 'Modification time', Type: 'RFC 3339', ReadOnly: false },
      },
      tier: { Help: 'Storage tier', Type: 'string', ReadOnly: true, Example: 'STANDARD' },
    },
  };

  const mockRemoteData = {
    remote: {
      displayName: 'my-drive',
      normalizedName: 'my_drive',
      type: 'drive',
    },
  };

  beforeEach(async () => {
    dialogRefSpy = { close: vi.fn() };
    remoteOpsSpy = { getSize: vi.fn().mockResolvedValue({ count: 42, bytes: 2048 }) };
    remoteFacadeSpy = {
      diskUsageSignal: vi.fn().mockReturnValue(
        signal({
          total: 100000,
          used: 40000,
          free: 60000,
          loading: false,
        })
      ),
      getCachedOrFetchDiskUsage: vi.fn().mockResolvedValue(undefined),
    };
    remoteManagementSpy = {
      clearCache: vi.fn(),
      getFsInfo: vi.fn().mockResolvedValue(mockFsInfo),
    };
    jobManagementSpy = {
      stopJobsByGroup: vi.fn().mockResolvedValue(undefined),
    };
    mapperSpy = {
      nanosecondsToDuration: vi.fn().mockReturnValue('1ms'),
    };

    await TestBed.configureTestingModule({
      imports: [RemoteAboutModalComponent],
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: dialogRefSpy },
        { provide: MAT_DIALOG_DATA, useValue: mockRemoteData },
        { provide: RemoteFileOperationsService, useValue: remoteOpsSpy },
        { provide: RemoteFacadeService, useValue: remoteFacadeSpy },
        { provide: RemoteManagementService, useValue: remoteManagementSpy },
        { provide: JobManagementService, useValue: jobManagementSpy },
        { provide: RcloneValueMapperService, useValue: mapperSpy },
        { provide: IconService, useValue: { getIconName: (): string => 'google-drive' } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(RemoteAboutModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should initialize and load data', async () => {
    expect(component).toBeTruthy();
    expect(component.displayName).toBe('my-drive');
    expect(remoteManagementSpy.clearCache).toHaveBeenCalledWith('my-drive');
    await fixture.whenStable();

    expect(component.aboutInfo()).toEqual(mockFsInfo);
    expect(component.root()).toBe('drive:/data');
    expect(component.precision()).toBe('1ms');
    expect(component.hashes()).toEqual(['md5', 'sha1']);
  });

  it('should compute features excluding IsLocal and sort them alphabetically', async () => {
    await fixture.whenStable();
    const feats = component.features();
    expect(feats.map(f => f.key)).toEqual(['About', 'BucketBased', 'Copy']);
    expect(feats.find(f => f.key === 'IsLocal')).toBeUndefined();
    expect(feats.find(f => f.key === 'About')?.value).toBe(true);
    expect(feats.find(f => f.key === 'BucketBased')?.value).toBe(false);
    expect(component.supportedFeaturesCount()).toBe(2);
  });

  it('should compute used percentage based on disk usage', () => {
    expect(component.usedPercentage()).toBe(40);
  });

  it('should compute metadata groups for system and standard items', async () => {
    await fixture.whenStable();
    const groups = component.metadataGroups();
    expect(groups.length).toBe(2);
    expect(groups[0].id).toBe('system');
    expect(groups[0].nameKey).toBe('fileBrowser.remoteAbout.metadata.system');
    expect(groups[0].items[0].key).toBe('mtime');
    expect(groups[1].id).toBe('standard');
    expect(groups[1].nameKey).toBe('fileBrowser.remoteAbout.metadata.standard');
    expect(groups[1].items[0].key).toBe('tier');
  });

  it('should close dialog and cancel jobs on close()', () => {
    component.close();
    expect(dialogRefSpy.close).toHaveBeenCalled();
  });

  it('should trigger fetchDiskUsage when requested', async () => {
    await component.fetchDiskUsage(true);
    expect(remoteFacadeSpy.getCachedOrFetchDiskUsage).toHaveBeenCalledWith(
      'my-drive',
      'my_drive',
      'dashboard',
      expect.any(String),
      true
    );
  });
});
