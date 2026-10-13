import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { FormGroup } from '@angular/forms';
import { provideTranslateService } from '@ngx-translate/core';
import { QuickRunEditorComponent } from './quick-run-editor.component';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';
import { FlagConfigService } from 'src/app/services/remote/flag-config.service';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { RemotePresetsService } from 'src/app/services/remote/remote-presets';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { PathInspectionService } from 'src/app/services/infrastructure/platform/path-inspection.service';
import { RcloneValueMapperService } from 'src/app/services/remote/rclone-value-mapper.service';
import { MountManagementService } from 'src/app/services/operations/mount-management.service';
import { ServeManagementService } from 'src/app/services/operations/serve-management.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { RcConfigOption } from '@app/types';

describe('QuickRunEditorComponent', () => {
  let fixture: ComponentFixture<QuickRunEditorComponent>;
  let component: QuickRunEditorComponent;

  const mockMountFields: RcConfigOption[] = [
    {
      Name: 'mountType',
      FieldName: 'mountType',
      Help: 'Mount type',
      Type: 'string',
      Default: 'mount',
      DefaultStr: 'mount',
    },
    {
      Name: 'readOnly',
      FieldName: 'readOnly',
      Help: 'Mount read only',
      Type: 'bool',
      Default: false,
      DefaultStr: 'false',
    },
  ];

  const mockServeBaseFields: RcConfigOption[] = [
    {
      Name: 'type',
      FieldName: 'type',
      Help: 'Serve type',
      Type: 'string',
      Default: 'http',
      DefaultStr: 'http',
    },
  ];

  const mockWebdavFields: RcConfigOption[] = [
    {
      Name: 'type',
      FieldName: 'type',
      Help: 'Serve type',
      Type: 'string',
      Default: 'webdav',
      DefaultStr: 'webdav',
    },
    {
      Name: 'user',
      FieldName: 'user',
      Help: 'WebDAV user',
      Type: 'string',
      DefaultStr: '',
    },
    {
      Name: 'pass',
      FieldName: 'pass',
      Help: 'WebDAV pass',
      Type: 'string',
      DefaultStr: '',
      IsPassword: true,
    },
  ];

  const allFlagsMock: Record<string, RcConfigOption[]> = {
    mount: mockMountFields,
    serve: mockServeBaseFields,
    sync: [],
    copy: [],
    vfs: [],
    filter: [],
    backend: [],
  };

  const allFlagFieldsSignal = signal<Record<string, RcConfigOption[]> | null>(allFlagsMock);

  let mountServiceMock: { getMountTypes: ReturnType<typeof vi.fn> };
  let serveServiceMock: { getServeTypes: ReturnType<typeof vi.fn> };
  let flagConfigServiceMock: {
    allFlagFields: ReturnType<typeof vi.fn>;
    loadAllFlagFields: ReturnType<typeof vi.fn>;
    loadServeFlagFields: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    mountServiceMock = {
      getMountTypes: vi.fn().mockResolvedValue(['mount', 'cmount', 'saf']),
    };

    serveServiceMock = {
      getServeTypes: vi.fn().mockResolvedValue(['http', 'webdav', 'ftp', 'sftp']),
    };

    flagConfigServiceMock = {
      allFlagFields: vi.fn().mockImplementation(() => allFlagFieldsSignal()),
      loadAllFlagFields: vi.fn().mockResolvedValue(allFlagsMock),
      loadServeFlagFields: vi.fn().mockImplementation((type: string) => {
        if (type === 'webdav') return Promise.resolve(mockWebdavFields);
        return Promise.resolve(mockServeBaseFields);
      }),
    };

    await TestBed.configureTestingModule({
      imports: [QuickRunEditorComponent],
      providers: [
        provideTranslateService(),
        {
          provide: QuickRunService,
          useValue: {
            isSaving: signal(false),
            save: vi.fn().mockResolvedValue(null),
          },
        },
        { provide: FlagConfigService, useValue: flagConfigServiceMock },
        {
          provide: RemoteManagementService,
          useValue: {
            getRemoteConfigFields: vi.fn().mockResolvedValue([]),
          },
        },
        {
          provide: RemoteFacadeService,
          useValue: {
            orderedVisibleRemotes: signal([{ name: 'test-remote', type: 'drive' }]),
          },
        },
        {
          provide: RemotePresetsService,
          useValue: {
            getPresetForType: vi.fn().mockReturnValue(null),
          },
        },
        {
          provide: NotificationService,
          useValue: {
            showSuccess: vi.fn(),
            showError: vi.fn(),
          },
        },
        {
          provide: PathService,
          useValue: {
            formatFsPath: vi.fn((p: string) => p),
            isLocalPath: vi.fn(() => false),
          },
        },
        {
          provide: PathInspectionService,
          useValue: {
            resolveDefaultPath: vi.fn().mockResolvedValue('/tmp/test'),
          },
        },
        { provide: RcloneValueMapperService, useClass: RcloneValueMapperService },
        { provide: MountManagementService, useValue: mountServiceMock },
        { provide: ServeManagementService, useValue: serveServiceMock },
        {
          provide: IconService,
          useValue: {
            getIconName: vi.fn(() => 'hard-drive'),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(QuickRunEditorComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should initialize subtype controls (mountType and type) with default values', () => {
    const mountOpts = component.form.get('mountConfig.options');
    const serveOpts = component.form.get('serveConfig.options');

    expect(mountOpts?.get('mountType')?.value).toBe('mount');
    expect(serveOpts?.get('type')?.value).toBe('http');
  });

  it('should load mountTypes and decorate Examples on mountType option', async () => {
    await fixture.whenStable();

    expect(mountServiceMock.getMountTypes).toHaveBeenCalled();
    expect(component.mountTypes()).toEqual(['mount', 'cmount', 'saf']);

    const mountFields = component.getFlagFields('mount');
    const mountTypeOpt = mountFields.find(f => f.Name === 'mountType');

    expect(mountTypeOpt).toBeDefined();
    expect(mountTypeOpt?.Examples).toBeDefined();
    expect(mountTypeOpt?.Examples?.map(e => e.Value)).toEqual(['mount', 'cmount', 'saf']);
  });

  it('should load serveTypes and decorate Examples on type option', async () => {
    await fixture.whenStable();

    expect(serveServiceMock.getServeTypes).toHaveBeenCalled();
    expect(component.availableServeTypes()).toEqual(['http', 'webdav', 'ftp', 'sftp']);

    const serveFields = component.getFlagFields('serve');
    const typeOpt = serveFields.find(f => f.Name === 'type');

    expect(typeOpt).toBeDefined();
    expect(typeOpt?.Examples).toBeDefined();
    expect(typeOpt?.Examples?.map(e => e.Value)).toEqual(['http', 'webdav', 'ftp', 'sftp']);
  });

  it('should dynamically update serve fields and options when serve type changes', async () => {
    await fixture.whenStable();

    await component.onServeTypeChange('webdav');
    fixture.detectChanges();

    expect(flagConfigServiceMock.loadServeFlagFields).toHaveBeenCalledWith('webdav');
    expect(component.selectedServeType()).toBe('webdav');

    const serveFields = component.getFlagFields('serve');
    expect(serveFields.some(f => f.Name === 'user')).toBe(true);
    expect(serveFields.some(f => f.Name === 'pass')).toBe(true);

    const serveOpts = component.form.get('serveConfig.options') as FormGroup | null;
    expect(serveOpts?.get('type')?.value).toBe('webdav');
    expect(serveOpts?.contains('user')).toBe(true);
    expect(serveOpts?.contains('pass')).toBe(true);
  });
});
