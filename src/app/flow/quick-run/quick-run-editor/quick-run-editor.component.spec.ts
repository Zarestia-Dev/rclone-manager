import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Signal, signal } from '@angular/core';
import { FormControl, FormGroup, Validators } from '@angular/forms';
import { MAT_DIALOG_DATA } from '@angular/material/dialog';
import { QuickRunEditorModalOptions } from 'src/app/services/ui/modal.service';
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
import {
  RcConfigOption,
  QuickRunInput,
  QuickRunConfig,
  PrimaryActionType,
  FlagType,
} from '@app/types';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';

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
    archivecreate: [
      {
        Name: 'format',
        FieldName: 'format',
        Type: 'string',
        Help: '',
        Default: 'zip',
        DefaultStr: 'zip',
      },
    ],
    cryptcheck: [
      {
        Name: 'oneWay',
        FieldName: 'oneWay',
        Type: 'bool',
        Help: '',
        Default: false,
        DefaultStr: 'false',
      },
    ],
    sync: [],
    copy: [],
    vfs: [],
    filter: [],
    backend: [],
  };

  let dialogData: QuickRunEditorModalOptions;

  let mountServiceMock: { getMountTypes: ReturnType<typeof vi.fn> };
  let serveServiceMock: { getServeTypes: ReturnType<typeof vi.fn> };
  let flagConfigServiceMock: {
    mountTypes: Signal<string[]>;
    availableServeTypes: Signal<string[]>;
    loadConfigFields: ReturnType<typeof vi.fn>;
    loadServeFlagFields: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    dialogData = {};
    mountServiceMock = {
      getMountTypes: vi.fn().mockResolvedValue(['mount', 'cmount', 'saf']),
    };

    serveServiceMock = {
      getServeTypes: vi.fn().mockResolvedValue(['http', 'webdav', 'ftp', 'sftp']),
    };

    flagConfigServiceMock = {
      mountTypes: signal(['mount', 'cmount', 'saf']),
      availableServeTypes: signal(['http', 'webdav', 'ftp', 'sftp']),
      loadConfigFields: vi
        .fn()
        .mockImplementation(async (types: FlagType[]) =>
          Object.fromEntries(types.map(type => [type, allFlagsMock[type] ?? []]))
        ),
      loadServeFlagFields: vi.fn().mockImplementation((type: string) => {
        if (type === 'webdav') return Promise.resolve(mockWebdavFields);
        return Promise.resolve(mockServeBaseFields);
      }),
    };

    await TestBed.configureTestingModule({
      imports: [QuickRunEditorComponent],
      providers: [
        provideTranslateService(),
        { provide: MAT_DIALOG_DATA, useValue: dialogData },
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
            remoteSummaries: signal([
              { name: 'test-remote', type: 'drive' },
              { name: 'other', type: 'drive' },
              { name: 'hidden', type: 's3' },
            ]),
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
        PathService,
        {
          provide: BackendService,
          useValue: { isWindows: signal(false), isLocalBackend: signal(true) },
        },
        {
          provide: PathInspectionService,
          useValue: {
            resolveDefaultPath: vi.fn().mockResolvedValue('/tmp/test'),
            createRequiredDirectoriesForOperation: vi.fn().mockResolvedValue(undefined),
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
    })
      .overrideComponent(QuickRunEditorComponent, { set: { template: '', imports: [] } })
      .compileComponents();

    TestBed.inject(PathService).setRemoteNames(['test-remote', 'other']);
    fixture = TestBed.createComponent(QuickRunEditorComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it.each([{ runtimeRemote: { region: 'eu' } }, { remotes: { 'test-remote': { region: 'eu' } } }])(
    'reads runtime options from saved configuration %j',
    async config => {
      component.form.patchValue({ remoteName: 'test-remote' });
      vi.mocked(TestBed.inject(RemoteManagementService).getRemoteConfigFields).mockResolvedValue([
        {
          Name: 'region',
          FieldName: 'region',
          Type: 'string',
          Help: '',
          Default: '',
          DefaultStr: '',
        },
      ]);
      const editor = component as unknown as {
        seedRcloneConfig: Record<string, unknown>;
        seedRemoteName: string;
        loadRuntimeRemoteFields(type: string): Promise<void>;
      };
      editor.seedRcloneConfig = config;
      editor.seedRemoteName = 'test-remote';
      await editor.loadRuntimeRemoteFields('drive');
      await fixture.whenStable();
      expect(component.runtimeRemoteForm().get('region')?.value).toBe('eu');
    }
  );

  it('writes runtime options under the owning remote for backend resolution', () => {
    component.form.patchValue({ name: 'Photos', remoteName: 'test-remote' });
    component.runtimeRemoteFields.set([
      {
        Name: 'region',
        FieldName: 'region',
        Type: 'string',
        Help: '',
        Default: '',
        DefaultStr: '',
      },
    ]);
    component.runtimeRemoteForm.set(
      new FormGroup({ type: new FormControl('drive'), region: new FormControl("a'b,c") })
    );
    const input = (component as unknown as { buildInput(): QuickRunInput }).buildInput();
    expect(input.config.rclone['remotes']).toEqual({ 'test-remote': { region: "a'b,c" } });
    expect(input.config.rclone['runtimeRemote']).toBeUndefined();
  });

  it.each([
    ['sync', { srcFs: ['test-remote:a', '/tmp/b'], dstFs: 'other:backup' }],
    ['copy', { srcFs: ['test-remote:a', 'other:b'], dstFs: '/tmp/backup' }],
    ['mount', { fs: 'test-remote:photos', mountPoint: 'saf://test-remote', mountType: 'saf' }],
    ['bisync', { path1: 'test-remote:a', path2: '/tmp/b' }],
    [
      'copyurl',
      {
        srcFs: ['https://example.com/a', 'https://example.com/b'],
        dstFs: '/tmp',
        filenames: ['a.jpg', 'b.jpg'],
        autoFilename: false,
      },
    ],
  ] as const)('preserves %s paths and scheduling through an edit', (operation, rclone) => {
    component.form.patchValue({
      name: 'Saved',
      remoteName: 'test-remote',
      operationType: operation,
    });
    const app = {
      autoStart: true,
      cronEnabled: true,
      cronExpression: '0 0 * * * *',
      watchEnabled: true,
      watchDelay: 7,
    };
    const editor = component as unknown as {
      createOpConfigGroup(operation: PrimaryActionType, seed: QuickRunConfig): FormGroup;
      buildInput(): QuickRunInput;
    };
    const group = editor.createOpConfigGroup(operation, { app, rclone: structuredClone(rclone) });
    component.form.setControl(`${operation}Config`, group);
    const saved = editor.buildInput().config;
    expect(saved.app).toMatchObject(app);
    expect(saved.rclone).toMatchObject(rclone);
  });

  it('loads legacy operation blocks and URL aliases without losing sources', () => {
    component.form.patchValue({
      name: 'Legacy',
      remoteName: 'test-remote',
      operationType: 'copyurl',
    });
    const editor = component as unknown as {
      createOpConfigGroup(operation: PrimaryActionType, seed: QuickRunConfig): FormGroup;
      buildInput(): QuickRunInput;
    };
    component.form.setControl(
      'copyurlConfig',
      editor.createOpConfigGroup('copyurl', {
        app: { autoStart: false },
        rclone: {
          copyurl: {
            url: ['https://example.com/a', 'https://example.com/b'],
            dstFs: '/tmp',
            autoFilename: true,
          },
        },
      })
    );
    expect(editor.buildInput().config.rclone).toMatchObject({
      srcFs: ['https://example.com/a', 'https://example.com/b'],
      dstFs: '/tmp',
      autoFilename: true,
    });
  });

  it('should initialize subtype controls (mountType and type) with default values', () => {
    const mountOpts = component.form.get('mountConfig.options');
    const serveOpts = component.form.get('serveConfig.options');

    expect(mountOpts?.get('mountType')?.value).toBe('mount');
    expect(serveOpts?.get('type')?.value).toBe('http');
  });

  it('should expose mountTypes from flagConfigService', async () => {
    await fixture.whenStable();

    expect(component.mountTypes()).toEqual(['mount', 'cmount', 'saf']);
  });

  it('should expose availableServeTypes from flagConfigService', async () => {
    await fixture.whenStable();

    expect(component.availableServeTypes()).toEqual(['http', 'webdav', 'ftp', 'sftp']);
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
  it.each(['mount', 'archivecreate', 'cryptcheck'] as const)(
    'initializes the requested %s operation before loading fields',
    async operation => {
      dialogData.initialOpType = operation;
      dialogData.initialRemoteName = 'test-remote';
      const opened = TestBed.createComponent(QuickRunEditorComponent);
      opened.detectChanges();
      await opened.whenStable();
      expect(opened.componentInstance.currentOpType()).toBe(operation);
      expect(opened.componentInstance.activeTab()).toBe(operation);
      expect(opened.componentInstance.form.get('operationType')?.value).toBe(operation);
      expect(flagConfigServiceMock.loadConfigFields).toHaveBeenCalledWith(
        expect.arrayContaining([operation])
      );
      if (operation === 'archivecreate')
        expect(opened.componentInstance.form.get('archivecreateConfig.options.format')?.value).toBe(
          'zip'
        );
      if (operation === 'cryptcheck')
        expect(opened.componentInstance.form.get('cryptcheckConfig.options.oneWay')?.value).toBe(
          false
        );
    }
  );

  it('preserves saved serve values after initial metadata loading', async () => {
    dialogData.cloneData = {
      name: 'Saved serve',
      remoteName: 'test-remote',
      operationType: 'serve',
      config: {
        app: { autoStart: false },
        rclone: { type: 'webdav', fs: 'test-remote:photos', user: "a'b,c", pass: 'secret' },
      },
    };
    const opened = TestBed.createComponent(QuickRunEditorComponent);
    opened.detectChanges();
    await opened.whenStable();
    expect(opened.componentInstance.form.get('serveConfig.options.user')?.value).toBe("a'b,c");
    expect(opened.componentInstance.form.get('serveConfig.options.pass')?.value).toBe('secret');
  });

  it('applies template values after changing the serve subtype', async () => {
    component.selectOperation('serve');
    await fixture.whenStable();
    await component.onApplyTemplate({
      sourceName: 'WebDAV',
      values: { serve: { type: 'webdav', user: 'alice', fs: 'other:photos' } },
    });
    expect(component.form.get('serveConfig.options.user')?.value).toBe('alice');
    expect(component.form.get('serveConfig.source.remote')?.value).toBe('other');
    expect(component.form.get('serveConfig.source.path')?.value).toBe('photos');
  });

  it('retains separate runtime drafts for remotes sharing a provider', async () => {
    vi.mocked(TestBed.inject(RemoteManagementService).getRemoteConfigFields).mockResolvedValue([
      {
        Name: 'region',
        FieldName: 'region',
        Type: 'string',
        Help: '',
        Default: '',
        DefaultStr: '',
      },
    ]);
    component.form.patchValue({ name: 'Drafts', remoteName: 'test-remote' });
    await fixture.whenStable();
    component.runtimeRemoteForm().get('region')?.setValue('eu');
    component.form.get('remoteName')?.setValue('other');
    await fixture.whenStable();
    expect(component.runtimeRemoteForm().get('region')?.value).toBe('');
    component.runtimeRemoteForm().get('region')?.setValue('us');
    component.form.get('remoteName')?.setValue('test-remote');
    await fixture.whenStable();
    expect(component.runtimeRemoteForm().get('region')?.value).toBe('eu');
    const input = (component as unknown as { buildInput(): QuickRunInput }).buildInput();
    expect(input.config.rclone['remotes']).toEqual({
      'test-remote': { region: 'eu' },
      other: { region: 'us' },
    });
  });

  it('resolves provider metadata for hidden catalogue remotes', async () => {
    component.form.get('remoteName')?.setValue('hidden');
    await fixture.whenStable();
    expect(component.selectedRemoteType()).toBe('s3');
    expect(TestBed.inject(RemoteManagementService).getRemoteConfigFields).toHaveBeenCalledWith(
      's3'
    );
  });

  it('validates submitted sections while ignoring inactive operations', async () => {
    component.form.patchValue({ name: 'Active sync', remoteName: 'test-remote' });
    await fixture.whenStable();
    const inactive = component.form.get('serveConfig.options') as FormGroup;
    inactive.addControl('invalid', new FormControl('', Validators.required));
    expect(component.form.invalid).toBe(true);
    expect(component.isSubmitDisabled()).toBe(false);
    component.form.get('syncConfig.cronEnabled')?.setValue(true);
    expect(component.isSubmitDisabled()).toBe(true);
  });

  it('blocks saving on metadata errors and allows a retry', async () => {
    flagConfigServiceMock.loadConfigFields.mockRejectedValueOnce(new Error('offline'));
    component.selectOperation('mount');
    await fixture.whenStable();
    expect(component.flagLoadFailed()).toBe(true);
    expect(component.isSubmitDisabled()).toBe(true);
    await component.retryLoading();
    expect(component.flagLoadFailed()).toBe(false);
  });

  it('guards repeated submissions during directory preparation', async () => {
    component.form.patchValue({ name: 'Once', remoteName: 'test-remote' });
    await fixture.whenStable();
    let finish: () => void = () => {
      /* assigned below */
    };
    vi.mocked(
      TestBed.inject(PathInspectionService).createRequiredDirectoriesForOperation
    ).mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        })
    );
    vi.mocked(TestBed.inject(QuickRunService).save).mockResolvedValue({ id: 'saved' } as Awaited<
      ReturnType<QuickRunService['save']>
    >);
    const first = component.submit();
    await component.submit();
    expect(component.isSaving()).toBe(true);
    finish();
    await first;
    expect(TestBed.inject(QuickRunService).save).toHaveBeenCalledOnce();
  });
  it('does not reload metadata when selecting the current operation', async () => {
    await (component as unknown as { fieldsReady: Promise<void> }).fieldsReady;
    const load = vi.mocked(TestBed.inject(FlagConfigService).loadConfigFields);
    const count = load.mock.calls.length;
    component.selectOperation(component.currentOpType());
    expect(load).toHaveBeenCalledTimes(count);
    expect(component.flagLoadFailed()).toBe(false);
  });

  it('treats a pending operation change as loading rather than failure', async () => {
    await (component as unknown as { fieldsReady: Promise<void> }).fieldsReady;
    let finish!: (value: Partial<Record<FlagType, RcConfigOption[]>>) => void;
    vi.mocked(TestBed.inject(FlagConfigService).loadConfigFields).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    component.selectOperation('mount');
    expect(component.isLoadingFlags()).toBe(true);
    expect(component.flagLoadFailed()).toBe(false);
    finish({ mount: [], vfs: [], filter: [], backend: [] });
    await (component as unknown as { fieldsReady: Promise<void> }).fieldsReady;
    expect(component.isLoadingFlags()).toBe(false);
    expect(component.flagLoadFailed()).toBe(false);
  });
});
