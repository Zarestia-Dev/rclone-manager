import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { MatIconRegistry } from '@angular/material/icon';
import { MAT_TABS_CONFIG, MatTabGroup } from '@angular/material/tabs';
import { By } from '@angular/platform-browser';
import { Observable, of } from 'rxjs';
import { ChangeDetectorRef, signal } from '@angular/core';
import { RemoteAboutModalComponent } from './remote-about-modal.component';
import { RemoteFileOperationsService } from 'src/app/services/remote/remote-file-operations.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { normalizeRemoteForRclone } from 'src/app/shared/utils/path.utils';
import { RemoteDiskUsageService } from 'src/app/services/remote/remote-disk-usage.service';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { RcloneValueMapperService } from 'src/app/services/remote/rclone-value-mapper.service';
import { FsInfo, RemoteProvider } from '@app/types';

describe('RemoteAboutModalComponent', () => {
  let fixture: ComponentFixture<RemoteAboutModalComponent>;
  let component: RemoteAboutModalComponent;
  let dialogRefSpy: { close: ReturnType<typeof vi.fn> };
  let remoteOpsSpy: { getSize: ReturnType<typeof vi.fn> };
  let remoteFacadeSpy: {
    usage: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
  };
  let remoteManagementSpy: {
    clearCache: ReturnType<typeof vi.fn>;
    getFsInfo: ReturnType<typeof vi.fn>;
    getRemoteTypes: ReturnType<typeof vi.fn>;
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
      usage: vi.fn().mockReturnValue(
        signal({
          total: 100000,
          used: 40000,
          free: 60000,
          loading: false,
        })
      ),
      load: vi.fn().mockResolvedValue(undefined),
    };
    remoteManagementSpy = {
      clearCache: vi.fn(),
      getFsInfo: vi.fn().mockResolvedValue(mockFsInfo),
      getRemoteTypes: vi.fn().mockResolvedValue([
        {
          name: 'drive',
          description: 'Google Drive',
          overview: { Name: 'Drive', Backend: 'drive', Tier: 'Tier 1' },
        },
      ]),
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
        provideTranslateService({ lang: 'en' }),
        { provide: MAT_TABS_CONFIG, useValue: { animationDuration: '0ms' } },
        { provide: MatDialogRef, useValue: dialogRefSpy },
        { provide: MAT_DIALOG_DATA, useValue: { remote: { ...mockRemoteData.remote } } },
        { provide: RemoteFileOperationsService, useValue: remoteOpsSpy },
        { provide: PathService, useValue: { normalizeRemoteForRclone } },
        { provide: RemoteDiskUsageService, useValue: remoteFacadeSpy },
        { provide: RemoteManagementService, useValue: remoteManagementSpy },
        { provide: JobManagementService, useValue: jobManagementSpy },
        { provide: RcloneValueMapperService, useValue: mapperSpy },
        { provide: IconService, useValue: { getIconName: (): string => 'google-drive' } },
        {
          provide: MatIconRegistry,
          useValue: {
            getNamedSvgIcon: (): Observable<SVGElement> =>
              of(document.createElementNS('http://www.w3.org/2000/svg', 'svg')),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(RemoteAboutModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => vi.restoreAllMocks());

  function recreate(): void {
    fixture.destroy();
    fixture = TestBed.createComponent(RemoteAboutModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

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

  it.each([
    ['my_drive', 'my_drive:'],
    ['my_drive:', 'my_drive:'],
    ['Arşiv yedek', 'Arşiv yedek:'],
    ['/home/user/data', '/home/user/data'],
  ])('requests size for %s using the filesystem %s', async (name, fs) => {
    await fixture.whenStable();
    component.data.remote.normalizedName = name;
    remoteOpsSpy.getSize.mockClear();
    recreate();
    await fixture.whenStable();
    await vi.waitFor(() => expect(component.loadingSize()).toBe(false));

    expect(remoteOpsSpy.getSize).toHaveBeenCalledWith(
      fs,
      undefined,
      'dashboard',
      expect.any(String)
    );
    expect(component.sizeInfo()).toEqual({ count: 42, bytes: 2048 });
    expect(component.loadingSize()).toBe(false);
  });

  it('finishes loading when the size request fails', async () => {
    await fixture.whenStable();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    remoteOpsSpy.getSize.mockRejectedValueOnce(new Error('backendErrors.remote.notFound'));
    recreate();
    await fixture.whenStable();
    await vi.waitFor(() => expect(component.loadingSize()).toBe(false));

    expect(component.sizeInfo()).toBeNull();
    expect(component.loadingSize()).toBe(false);
    expect(component.aboutInfo()).toEqual(mockFsInfo);
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
    expect(remoteFacadeSpy.load).toHaveBeenCalledWith('my_drive', {
      group: expect.any(String),
      force: true,
    });
  });

  it('shows the full provider name, support tier and provider documentation', async () => {
    await fixture.whenStable();
    fixture.detectChanges();
    const summary = (fixture.nativeElement as HTMLElement).querySelector('.provider-summary');
    expect(summary?.textContent).toContain('Google Drive');
    expect(summary?.querySelector('.app-pill')?.textContent?.trim()).toBe('Tier 1');
    expect(summary?.querySelector('.app-pill')?.classList.contains('p-primary')).toBe(true);
    expect(summary?.querySelector('a')?.getAttribute('href')).toBe('https://rclone.org/drive/');
    expect(summary?.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it.each([
    ['Tier 1', 'p-primary'],
    ['Tier 2', 'p-yellow'],
    ['Tier 3', 'p-orange'],
    ['Tier 4', 'p-warn'],
    ['Tier 5', 'p-warn'],
  ])('renders %s in %s', async (tier, colour) => {
    await fixture.whenStable();
    component.provider.set({ name: 'drive', description: 'Drive', overview: { Tier: tier } });
    fixture.detectChanges();
    const pill = (fixture.nativeElement as HTMLElement).querySelector(
      '.provider-summary .app-pill'
    );
    expect(pill?.classList.contains(colour)).toBe(true);
  });

  it.each([undefined, null, {}])(
    'keeps older providers usable with overview %s',
    async overview => {
      remoteManagementSpy.getRemoteTypes.mockResolvedValueOnce([
        { name: 'drive', description: 'Google Drive', overview },
      ]);
      recreate();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(component.providerName()).toBe('Google Drive');
      expect(component.providerTier()).toBeUndefined();
      expect(component.providerDocumentationUrl()).toBe('https://rclone.org/drive/');
      expect(
        (fixture.nativeElement as HTMLElement).querySelector('.provider-summary .app-pill')
      ).toBeNull();
      expect(component.aboutInfo()).toEqual(mockFsInfo);
    }
  );

  it('uses the embedded backend slug for provider names containing spaces', async () => {
    await fixture.whenStable();
    component.provider.set({
      name: 'google cloud storage',
      description: 'Google Cloud Storage',
      overview: { Backend: 'googlecloudstorage', Name: 'Google Cloud Storage' },
    });
    expect(component.providerDocumentationUrl()).toBe('https://rclone.org/googlecloudstorage/');
    component.provider.set({ name: '../other?query#fragment', description: 'Unknown' });
    expect(component.providerDocumentationUrl()).toBe('https://rclone.org/overview/');
  });

  it('keeps live capabilities separate from the virtual provider overview', async () => {
    remoteManagementSpy.getRemoteTypes.mockResolvedValueOnce([
      {
        name: 'drive',
        description: 'Wrapper',
        overview: { Virtual: true, Hashes: ['sha256'], Features: ['Move'] },
      },
    ]);
    recreate();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.provider-summary')?.textContent
    ).toContain('wizards.remoteConfig.providerOverview.virtualNote');
    expect(component.hashes()).toEqual(['md5', 'sha1']);
    expect(component.features().find(feature => feature.key === 'Copy')?.value).toBe(true);
    expect(component.features().find(feature => feature.key === 'Move')).toBeUndefined();
  });

  it('translates known feature names while retaining unknown names and actual support flags', async () => {
    await fixture.whenStable();
    component.aboutInfo.set({
      Features: {
        Copy: false,
        PublicLink: true,
        ReadMimeType: true,
        FutureFeature: true,
        constructor: true,
      },
    });
    expect(component.features()).toEqual(
      expect.arrayContaining([
        { key: 'Copy', value: false, labelKey: 'wizards.remoteConfig.providerOverview.copy' },
        {
          key: 'PublicLink',
          value: true,
          labelKey: 'wizards.remoteConfig.providerOverview.publicLink',
        },
        {
          key: 'ReadMimeType',
          value: true,
          labelKey: 'fileBrowser.remoteAbout.featureLabels.readMimeType',
        },
        { key: 'FutureFeature', value: true, labelKey: undefined },
        { key: 'constructor', value: true, labelKey: undefined },
      ])
    );
    component.aboutInfo.set({ Features: {} });
    expect(component.features()).toEqual([]);
  });

  it('does not request provider metadata when the remote type is unknown', async () => {
    component.data.remote.type = undefined;
    remoteManagementSpy.getRemoteTypes.mockClear();
    recreate();
    await fixture.whenStable();
    expect(remoteManagementSpy.getRemoteTypes).not.toHaveBeenCalled();
    expect(component.aboutInfo()).toEqual(mockFsInfo);
  });

  it('renders translated feature names with technical names in native tooltips', async () => {
    TestBed.inject(TranslateService).setTranslation('en', {
      wizards: { remoteConfig: { providerOverview: { copy: 'Server-side copy' } } },
    });
    await fixture.whenStable();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const tabsElement = fixture.debugElement.query(By.directive(MatTabGroup));
    const tabs = tabsElement.componentInstance as MatTabGroup;
    tabs.selectedIndex = 1;
    tabsElement.injector.get(ChangeDetectorRef).markForCheck();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelector('.feature-name[title="Copy"]')?.textContent?.trim()).toBe(
        'Server-side copy'
      );
    });
  });

  it.each(['unavailable', 'no match'])(
    'keeps live information when provider metadata is %s',
    async scenario => {
      if (scenario === 'unavailable')
        remoteManagementSpy.getRemoteTypes.mockRejectedValueOnce(new Error('offline'));
      else
        remoteManagementSpy.getRemoteTypes.mockResolvedValueOnce([
          { name: 's3', description: 'S3' },
        ]);
      recreate();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(component.provider()).toBeNull();
      expect(component.aboutInfo()).toEqual(mockFsInfo);
      expect(component.errorAbout()).toBeNull();
      expect((fixture.nativeElement as HTMLElement).querySelector('.provider-summary')).toBeNull();
    }
  );

  it('shows provider information even when live fsinfo fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    remoteManagementSpy.getFsInfo.mockRejectedValueOnce(new Error('connection failed'));
    recreate();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(component.errorAbout()).toContain('connection failed');
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.provider-summary')?.textContent
    ).toContain('Google Drive');
  });

  it('ignores late provider metadata after the dialog has closed', async () => {
    let resolve!: (providers: RemoteProvider[]) => void;
    remoteManagementSpy.getRemoteTypes.mockReturnValueOnce(
      new Promise<RemoteProvider[]>(done => {
        resolve = done;
      })
    );
    recreate();
    await vi.waitFor(() => expect(component.aboutInfo()).toEqual(mockFsInfo));
    fixture.destroy();
    resolve([{ name: 'drive', description: 'Late data' }]);
    await Promise.resolve();
    expect(component.provider()).toBeNull();
  });
});
