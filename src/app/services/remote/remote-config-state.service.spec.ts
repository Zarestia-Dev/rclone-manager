import { TestBed } from '@angular/core/testing';
import { FormBuilder, FormControl, FormGroup, Validators } from '@angular/forms';
import { WritableSignal, signal } from '@angular/core';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { provideTranslateService } from '@ngx-translate/core';
import { DialogData, RemoteConfigStateService } from './remote-config-state.service';
import { AuthStateService } from '../security/auth-state.service';
import { RemoteManagementService } from './remote-management.service';
import { MountManagementService } from '../operations/mount-management.service';
import { ServeManagementService } from '../operations/serve-management.service';
import { FlagConfigService } from './flag-config.service';
import { ValidatorRegistryService } from '../ui/validation/validator-registry.service';
import { IconService } from '../ui/icon.service';
import { JobManagementService } from '../operations/job-management.service';
import { NotificationService } from '../ui/notification.service';
import { PathService } from '../infrastructure/platform/path.service';
import { PathInspectionService } from '../infrastructure/platform/path-inspection.service';
import { RcloneValueMapperService } from './rclone-value-mapper.service';
import { RemoteFacadeService } from '../facade/remote-facade.service';
import { RemotePresetsService } from './remote-presets';
import { RemoteCreationOrchestrator } from './remote-creation-orchestrator.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { BackendService } from '../infrastructure/system/backend.service';
import { createDefaultRemoteFeatures, createDefaultRemoteStatus, RcConfigOption } from '@app/types';
import { ImportResult } from './cli-flag-mapper.service';

describe('RemoteConfigStateService', () => {
  let service: RemoteConfigStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        FormBuilder,
        RemoteConfigStateService,
        {
          provide: AuthStateService,
          useValue: {
            isAuthInProgress: signal(false),
            isAuthCancelled: signal(false),
            oauthUrl: signal(null),
          },
        },
        {
          provide: RemoteManagementService,
          useValue: {
            getRemotes: vi.fn().mockResolvedValue([]),
            getRemoteConfigFields: vi.fn().mockResolvedValue([]),
            getRemoteTypes: vi.fn().mockResolvedValue([]),
          },
        },
        {
          provide: MountManagementService,
          useValue: {
            getMountTypes: vi.fn().mockResolvedValue([]),
          },
        },
        {
          provide: ServeManagementService,
          useValue: {
            getServeTypes: vi.fn().mockResolvedValue([]),
            getServeConfigFields: vi.fn().mockResolvedValue([]),
          },
        },
        {
          provide: FlagConfigService,
          useValue: {
            loadAllFlagFields: vi.fn().mockResolvedValue({}),
            loadConfigFields: vi.fn().mockResolvedValue({}),
            loadServeFlagFields: vi.fn().mockResolvedValue([]),
          },
        },
        {
          provide: ValidatorRegistryService,
          useValue: {
            createRemoteNameValidator: vi.fn().mockReturnValue(() => null),
            setupOperationValidation: vi.fn(),
          },
        },
        {
          provide: IconService,
          useValue: {
            getIconName: vi.fn().mockReturnValue('hard-drive'),
          },
        },
        {
          provide: JobManagementService,
          useValue: {},
        },
        {
          provide: NotificationService,
          useValue: {
            showSuccess: vi.fn(),
            showError: vi.fn(),
            showWarning: vi.fn(),
          },
        },
        PathService,
        {
          provide: BackendService,
          useValue: { isWindows: (): boolean => false, activeBackend: signal('Local') },
        },
        {
          provide: PathInspectionService,
          useValue: {
            createRequiredDirectories: vi.fn().mockResolvedValue(undefined),
            resolveDefaultPath: vi.fn().mockResolvedValue('/default/path'),
          },
        },
        RcloneValueMapperService,
        {
          provide: RemoteFacadeService,
          useValue: {
            loadRemotes: vi.fn().mockResolvedValue([]),
            getRemote: vi.fn(),
            cloneRemote: vi.fn().mockResolvedValue(null),
            getRemoteSettings: vi.fn().mockReturnValue({}),
          },
        },
        {
          provide: RemotePresetsService,
          useValue: {
            resolvePresets: vi.fn().mockReturnValue({}),
          },
        },
        {
          provide: RemoteCreationOrchestrator,
          useValue: {
            isInteractiveContinueDisabled: signal(false),
            oauthHelperUrl: signal(null),
          },
        },
        {
          provide: AppSettingsService,
          useValue: {
            saveRemoteSettings: vi.fn().mockResolvedValue(undefined),
          },
        },
      ],
    });

    service = TestBed.inject(RemoteConfigStateService);
  });

  const setDialogData = (data: DialogData): void => {
    (service as unknown as { dialogData: WritableSignal<DialogData> }).dialogData.set(data);
  };

  const field = (name: string, defaultValue = ''): RcConfigOption => ({
    Name: name,
    FieldName: name,
    Type: 'string',
    Default: defaultValue,
    DefaultStr: defaultValue,
    Help: '',
  });

  describe('profile persistence', () => {
    it('uses the last successful save as the baseline for subsequent edits', async () => {
      const initial = {
        syncConfigs: { Default: { app: {}, rclone: { srcFs: '/old', dstFs: 'drive:' } } },
      };
      (service as unknown as { initialConfig: unknown }).initialConfig = initial;
      service.initProfiles({ remoteType: 'drive' });
      const saved = { app: {}, rclone: { srcFs: '/first', dstFs: 'drive:' } };
      service.updateProfileConfig('sync', 'Default', saved);
      expect(await service.saveRemoteProfiles('drive')).toBe(true);
      const next = { app: {}, rclone: { srcFs: '/second', dstFs: 'drive:' } };
      service.updateProfileConfig('sync', 'Default', next);
      expect(await service.saveRemoteProfiles('drive')).toBe(true);
      expect(TestBed.inject(AppSettingsService).saveRemoteSettings).toHaveBeenLastCalledWith(
        'drive',
        { syncConfigs: { Default: next } },
        'Local'
      );
      expect(initial.syncConfigs.Default.rclone.srcFs).toBe('/old');
    });

    it('sends changed sections with their backend owner', async () => {
      const original = {
        syncConfigs: { Default: { app: {}, rclone: { srcFs: '/old', dstFs: 'drive:' } } },
        mountConfigs: { Default: { app: {}, rclone: { fs: 'drive:', mountPoint: '/mnt' } } },
      };
      (service as unknown as { initialConfig: unknown }).initialConfig = original;
      service.initProfiles({ remoteType: 'drive' });
      service.updateProfileConfig('sync', 'Default', {
        app: {},
        rclone: { srcFs: '/new', dstFs: 'drive:' },
      });
      const save = vi.mocked(TestBed.inject(AppSettingsService).saveRemoteSettings);
      expect(await service.saveRemoteProfiles('drive')).toBe(true);
      expect(save).toHaveBeenCalledWith(
        'drive',
        {
          syncConfigs: { Default: { app: {}, rclone: { srcFs: '/new', dstFs: 'drive:' } } },
        },
        'Local'
      );
      expect(
        vi.mocked(TestBed.inject(PathInspectionService).createRequiredDirectories).mock
          .invocationCallOrder[0]
      ).toBeLessThan(save.mock.invocationCallOrder[0]);
    });

    it('preserves deletion intent and keeps the baseline on a failed save', async () => {
      const original = {
        syncConfigs: { Old: { app: {}, rclone: { srcFs: '/old', dstFs: 'drive:' } } },
      };
      (service as unknown as { initialConfig: unknown }).initialConfig = original;
      service.initProfiles({ remoteType: 'drive' });
      service.profiles.update(profiles => ({ ...profiles, sync: {} }));
      const save = vi.mocked(TestBed.inject(AppSettingsService).saveRemoteSettings);
      const failure = new Error('save failed');
      save.mockRejectedValueOnce(failure);
      expect(await service.saveRemoteProfiles('drive')).toBe(false);
      expect(TestBed.inject(NotificationService).showError).toHaveBeenCalledWith(failure);
      expect(await service.saveRemoteProfiles('drive')).toBe(true);
      expect(save).toHaveBeenNthCalledWith(1, 'drive', { syncConfigs: {} }, 'Local');
      expect(save).toHaveBeenNthCalledWith(2, 'drive', { syncConfigs: {} }, 'Local');
    });
  });

  describe('displayed Default profiles', () => {
    beforeEach(() => {
      service.initProfiles({ remoteType: 'drive' });
    });

    it('shows defaults without inserting them into saved profile collections', async () => {
      expect(service.profiles().filter).toEqual({});
      expect(service.profileNamesMap().filter).toEqual(['Default']);
      expect(service.profileLists().filter).toEqual([{ name: 'Default' }]);
      expect(service.profileOptions().filter).toEqual(['Default']);
      await service.selectProfile('filter', 'Default');
      service.saveCurrentProfile('filter');
      expect(service.profiles().filter).toEqual({});
      expect(await service.saveRemoteProfiles('drive')).toBe(true);
      expect(TestBed.inject(AppSettingsService).saveRemoteSettings).toHaveBeenCalledWith(
        'drive',
        {},
        'Local'
      );
    });

    it('materializes an edited default in the saved section', async () => {
      service.dynamicFlagFields.update(fields => ({ ...fields, filter: [field('include', '')] }));
      service.addDynamicFieldsToForm();
      const control = service.remoteConfigForm.get('filterConfig.options.include') as FormControl;
      control.setValue('*.jpg');
      control.markAsDirty();
      expect(await service.saveRemoteProfiles('drive')).toBe(true);
      expect(TestBed.inject(AppSettingsService).saveRemoteSettings).toHaveBeenCalledWith(
        'drive',
        { filterConfigs: { Default: { include: '*.jpg' } } },
        'Local'
      );
    });

    it('persists an explicitly saved empty Default', async () => {
      expect(await service.saveRemoteProfiles('drive', 'filter')).toBe(true);
      expect(TestBed.inject(AppSettingsService).saveRemoteSettings).toHaveBeenCalledWith(
        'drive',
        { filterConfigs: { Default: {} } },
        'Local'
      );
    });

    it('saves serve defaults sparsely and removes autoStart when switched back off', async () => {
      service.remoteForm.patchValue({ name: 'drive' });
      await service.selectProfile('serve', 'Default');
      const group = service.getOperationConfigGroup('serve');
      const save = vi.mocked(TestBed.inject(AppSettingsService).saveRemoteSettings);
      expect(await service.saveRemoteProfiles('drive', 'serve')).toBe(true);
      const defaults = { app: {}, rclone: { fs: 'drive:' } };
      expect(save).toHaveBeenLastCalledWith(
        'drive',
        { serveConfigs: { Default: defaults } },
        'Local'
      );
      group.get('autoStart')?.setValue(true);
      expect(await service.saveRemoteProfiles('drive', 'serve')).toBe(true);
      const enabled = { app: { autoStart: true }, rclone: { fs: 'drive:' } };
      expect(save).toHaveBeenLastCalledWith(
        'drive',
        { serveConfigs: { Default: enabled } },
        'Local'
      );
      group.get('autoStart')?.setValue(false);
      expect(await service.saveRemoteProfiles('drive', 'serve')).toBe(true);
      expect(save).toHaveBeenLastCalledWith(
        'drive',
        { serveConfigs: { Default: defaults } },
        'Local'
      );
    });

    it('does not resurrect the last deleted profile while displaying Default', async () => {
      (service as unknown as { initialConfig: unknown }).initialConfig = {
        filterConfigs: { Default: {} },
      };
      service.initProfiles({ remoteType: 'drive' });
      service.deleteProfile('filter', 'Default');
      await Promise.resolve();
      expect(service.selectedProfileName().filter).toBe('Default');
      expect(service.profiles().filter).toEqual({});
      expect(await service.saveRemoteProfiles('drive')).toBe(true);
      expect(TestBed.inject(AppSettingsService).saveRemoteSettings).toHaveBeenCalledWith(
        'drive',
        { filterConfigs: {} },
        'Local'
      );
    });

    it('can duplicate and rename a displayed default into a real profile', async () => {
      service.duplicateProfile('filter', 'Default');
      await Promise.resolve();
      expect(service.selectedProfileName().filter).toBe('Default-1');
      expect(service.profiles().filter).toEqual({ 'Default-1': {} });
      await vi.waitFor(() => expect(service.profileState().filter.mode).toBe('edit'));
      service.setProfileTempName('filter', 'Photos');
      service.saveProfile('filter');
      expect(service.profiles().filter).toEqual({ Photos: {} });
    });
  });

  describe('profile transitions', () => {
    beforeEach(() => {
      service.initProfiles({ remoteType: 'drive' });
      service.remoteForm.patchValue({ name: 'my-drive', type: 'drive' });
      service.dynamicFlagFields.update(fields => ({
        ...fields,
        vfs: [field('vfs_cache_mode', 'off')],
        mount: [field('read_only', 'false')],
      }));
      service.addDynamicFieldsToForm();
    });

    it('prevents deletion of a filter referenced by an operation profile', () => {
      service.updateProfileConfig('filter', 'SafeFiles', { include: ['*.jpg'] });
      service.updateProfileConfig('sync', 'Default', {
        app: { filterProfile: 'SafeFiles' },
        rclone: { srcFs: '/src', dstFs: 'drive:' },
      });
      service.deleteProfile('filter', 'SafeFiles');
      expect(service.profiles().filter['SafeFiles']).toEqual({ include: ['*.jpg'] });
      expect(TestBed.inject(NotificationService).showWarning).toHaveBeenCalled();
      expect(service.getProfileActionState('filter', 'SafeFiles').delete.disabled).toBe(true);
    });

    it('resets missing options to defaults when switching profiles and preserves validators', async () => {
      service.updateProfileConfig('vfs', 'Full', { vfs_cache_mode: 'full', custom: 'old' });
      service.updateProfileConfig('vfs', 'Empty', {});
      const control = service.remoteConfigForm.get(
        'vfsConfig.options.vfs_cache_mode'
      ) as FormControl;
      control.addValidators(Validators.required);

      await service.selectProfile('vfs', 'Full');
      await service.selectProfile('vfs', 'Empty');

      expect(control.value).toBe('off');
      expect(control.hasValidator(Validators.required)).toBe(true);
      expect(service.remoteConfigForm.get('vfsConfig.options.custom')).toBeNull();
    });

    it('copies the latest edits when duplicating the selected profile', async () => {
      service.updateProfileConfig('vfs', 'Default', { vfs_cache_mode: 'writes' });
      await service.selectProfile('vfs', 'Default');
      service.remoteConfigForm.get('vfsConfig.options.vfs_cache_mode')?.setValue('full');

      service.duplicateProfile('vfs', 'Default');
      await Promise.resolve();

      const selected = service.selectedProfileName().vfs ?? '';
      expect(selected).toBeTruthy();
      expect(selected).not.toBe('Default');
      expect(service.profiles().vfs[selected]).toEqual({ vfs_cache_mode: 'full' });
      expect(service.remoteConfigForm.get('vfsConfig.options.vfs_cache_mode')?.value).toBe('full');
    });

    it('duplicates an inactive profile without replacing it with the active form values', async () => {
      service.updateProfileConfig('vfs', 'Other', { vfs_cache_mode: 'writes' });
      service.remoteConfigForm.get('vfsConfig.options.vfs_cache_mode')?.setValue('full');
      service.remoteConfigForm.get('vfsConfig')?.markAsDirty();

      service.duplicateProfile('vfs', 'Other');
      await Promise.resolve();

      expect(service.profiles().vfs[service.selectedProfileName().vfs ?? '']).toEqual({
        vfs_cache_mode: 'writes',
      });
      expect(service.profiles().vfs['Default']).toEqual({ vfs_cache_mode: 'full' });
    });

    it('does not create a duplicate for a missing profile', () => {
      const profiles = service.profiles();
      service.duplicateProfile('vfs', 'missing');
      expect(service.profiles()).toBe(profiles);
    });

    it.each(['vfs', 'filter', 'backend', 'runtimeRemote'] as const)(
      'updates stored and form references when a %s profile is renamed',
      async type => {
        const key = `${type}Profile`;
        service.updateProfileConfig(type, 'Old profile', {});
        await service.selectProfile(type, 'Old profile');
        service.updateProfileConfig('mount', 'Default', {
          app: { [key]: 'Old profile', autoStart: true },
          rclone: { fs: 'my-drive:' },
        });
        service.updateProfileConfig('sync', 'Legacy', { [key]: 'Old profile', srcFs: '/src' });
        service.updateProfileConfig('copy', 'Untouched', { app: { [key]: 'Another' } });
        service.remoteConfigForm.get(`mountConfig.${key}`)?.setValue('Old profile');
        service.startEditProfile(type);
        service.setProfileTempName(type, 'Yeni profil + 1');

        service.saveProfile(type);
        service.saveCurrentProfile('mount');

        expect(service.profiles()[type]['Old profile']).toBeUndefined();
        expect(service.profiles()[type]['Yeni profil + 1']).toBeDefined();
        expect(service.profiles().mount['Default']).toMatchObject({
          app: { [key]: 'Yeni profil + 1' },
        });
        expect(service.profiles().sync['Legacy']).toMatchObject({ [key]: 'Yeni profil + 1' });
        expect(service.profiles().copy['Untouched']).toMatchObject({ app: { [key]: 'Another' } });
      }
    );

    it('does not rename over an existing profile', () => {
      service.updateProfileConfig('vfs', 'Existing', { vfs_cache_mode: 'full' });
      service.startEditProfile('vfs');
      service.setProfileTempName('vfs', 'Existing');
      const profiles = service.profiles();

      service.saveProfile('vfs');

      expect(service.profiles()).toBe(profiles);
    });

    it('preserves unsaved paths, automation settings and other flags when applying a template', async () => {
      service.remoteConfigForm.get('mountConfig')?.patchValue({
        autoStart: true,
        source: { type: 'currentRemote', path: 'photos' },
        dest: { type: 'local', path: '/chosen mount' },
      });
      service.remoteConfigForm.get('mountConfig')?.markAsDirty();
      const options = service.remoteConfigForm.get('mountConfig.options') as FormGroup;
      options.addControl('customFlag', new FormControl('keep'));

      service.applyTemplate({ mount: { read_only: true } }, 'mount');
      await vi.waitFor(() => expect(service.isPopulatingForm()).toBe(false));

      expect(service.remoteConfigForm.get('mountConfig.autoStart')?.value).toBe(true);
      expect(service.remoteConfigForm.get('mountConfig.dest.path')?.value).toBe('/chosen mount');
      expect(service.remoteConfigForm.get('mountConfig.source.path')?.value).toBe('photos');
      expect(options.get('customFlag')?.value).toBe('keep');
      expect(options.get('read_only')?.value).toBe(true);
    });

    it.each(['check', 'delete', 'copyurl', 'archivecreate', 'cryptcheck'] as const)(
      'applies templates to %s operation profiles',
      type => {
        service.applyTemplate({ [type]: { dry_run: true } }, type);
        expect(service.profiles()[type]['Default']).toMatchObject({ rclone: { dry_run: true } });
      }
    );
  });

  describe('CLI import linked profiles', () => {
    const importResult: ImportResult = {
      verb: 'sync',
      sourcePath: 'my-drive:photos',
      destPath: '/backup',
      classified: [
        {
          flag: { key: 'include', raw: '--include=*.txt', value: '*.txt', hasMacro: false },
          status: 'mapped',
          flagType: 'filter',
          fieldName: 'include',
          coercedValue: ['*.txt'],
        },
      ],
    };

    it.each(['new', 'patch', 'override'] as const)(
      'persists the filter connection through population and saving in %s mode',
      async mode => {
        service.initProfiles({ remoteType: 'drive' });
        service.remoteForm.patchValue({ name: 'my-drive', type: 'drive' });
        const name = mode === 'patch' ? 'Default' : 'Imported';

        await service.applyImportResult({
          result: importResult,
          profileName: name,
          mode,
          importSourcePath: true,
          importDestPath: true,
        });
        service.saveCurrentProfile('sync');

        expect(service.remoteConfigForm.get('syncConfig.filterProfile')?.value).toBe(name);
        expect(service.selectedProfileName().filter).toBe(name);
        expect(service.profiles().sync[name]).toMatchObject({
          app: name === 'Default' ? {} : { filterProfile: name },
          rclone: { srcFs: 'my-drive:photos', dstFs: '/backup' },
        });
        expect(
          (service.profiles().sync[name] as { app: { filterProfile?: string } }).app
            .filterProfile ?? 'Default'
        ).toBe(name);
        expect(service.profiles().filter[name]).toEqual({ include: ['*.txt'] });
      }
    );

    it('preserves current automation settings when patching imported flags', async () => {
      service.initProfiles({ remoteType: 'drive' });
      service.remoteConfigForm.get('syncConfig.autoStart')?.setValue(true);
      service.remoteConfigForm.get('syncConfig.autoStart')?.markAsDirty();
      await service.applyImportResult({
        result: importResult,
        profileName: 'Default',
        mode: 'patch',
        importSourcePath: false,
        importDestPath: false,
      });
      expect(service.remoteConfigForm.get('syncConfig.autoStart')?.value).toBe(true);
    });
  });

  describe('isEditingExisting and saveButtonLabel', () => {
    it('should be in create mode when cloning from another remote', () => {
      setDialogData({
        cloneFrom: 'Google Drive',
        remoteType: 'drive',
      });

      expect(service.isEditingExisting()).toBe(false);
      expect(service.saveButtonLabel()).toBe('common.create');
    });

    it('should be in create mode even if name is present alongside cloneFrom', () => {
      setDialogData({
        name: 'Google Drive',
        cloneFrom: 'Google Drive',
        remoteType: 'drive',
      });

      expect(service.isEditingExisting()).toBe(false);
      expect(service.saveButtonLabel()).toBe('common.create');
    });

    it('should be in edit mode when name is provided without cloneFrom', () => {
      setDialogData({
        name: 'Google Drive',
        remoteType: 'drive',
      });

      expect(service.isEditingExisting()).toBe(true);
      expect(service.saveButtonLabel()).toBe('common.save');
    });

    it('should be in create mode when creating a brand new remote', () => {
      setDialogData({
        remoteType: '',
      });

      expect(service.isEditingExisting()).toBe(false);
      expect(service.saveButtonLabel()).toBe('common.create');
    });
  });

  describe('generateNewCloneName', () => {
    it('should append -clone to base remote name without double suffixing', () => {
      service.remoteForm.get('name')?.setValue('Google Drive');
      service.existingRemotes.set(['Google Drive']);

      service.generateNewCloneName();

      expect(service.remoteForm.get('name')?.value).toBe('Google Drive-clone');
    });

    it('should not accumulate multiple -clone suffixes', () => {
      service.remoteForm.get('name')?.setValue('Google Drive-clone');
      service.existingRemotes.set(['Google Drive', 'Google Drive-clone']);

      service.generateNewCloneName();

      expect(service.remoteForm.get('name')?.value).toBe('Google Drive-clone-1');
    });
  });

  describe('applyTemplate', () => {
    it('should patch options into rclone sub-object for operation profiles and flat for vfs', () => {
      service.initProfiles({ remoteType: 'drive' });

      service.applyTemplate({
        vfs: { vfs_cache_mode: 'full' },
        sync: { bwlimit: '10M', transfers: 4 },
        mount: { attr_timeout: '5s' },
      });

      const profiles = service.profiles();

      const vfsProfile = profiles['vfs']?.['Default'] as Record<string, unknown> | undefined;
      expect(vfsProfile?.['vfs_cache_mode']).toBe('full');

      const syncProfile = profiles['sync']?.['Default'] as
        { rclone?: Record<string, unknown> } | undefined;
      expect(syncProfile?.rclone?.['bwlimit']).toBe('10M');
      expect(syncProfile?.rclone?.['transfers']).toBe(4);

      const mountProfile = profiles['mount']?.['Default'] as
        { rclone?: Record<string, unknown> } | undefined;
      expect(mountProfile?.rclone?.['attr_timeout']).toBe('5s');
    });

    it('should only patch allowed categories when target context is scoped (e.g. sync should not touch vfs or mount)', () => {
      service.initProfiles({ remoteType: 'drive' });

      service.applyTemplate(
        {
          vfs: { vfs_cache_mode: 'full' },
          mount: { attr_timeout: '5s' },
          sync: { bwlimit: '10M', transfers: 4 },
        },
        'sync'
      );

      const profiles = service.profiles();

      // sync was allowed, so it should be patched
      const syncProfile = profiles['sync']?.['Default'] as
        { rclone?: Record<string, unknown> } | undefined;
      expect(syncProfile?.rclone?.['bwlimit']).toBe('10M');
      expect(syncProfile?.rclone?.['transfers']).toBe(4);

      // vfs and mount are NOT allowed for sync context, so they must NOT be modified
      const vfsProfile = profiles['vfs']?.['Default'] as Record<string, unknown> | undefined;
      expect(vfsProfile?.['vfs_cache_mode']).toBeUndefined();

      const mountProfile = profiles['mount']?.['Default'] as
        { rclone?: Record<string, unknown> } | undefined;
      expect(mountProfile?.rclone?.['attr_timeout']).toBeUndefined();
    });
  });

  describe('init error handling on clone failure', () => {
    it('should notify and throw error when cloneRemote returns null', async () => {
      const notificationService = TestBed.inject(NotificationService);

      await expect(
        service.init({
          cloneFrom: 'NonExistentRemote',
          remoteType: 'drive',
        })
      ).rejects.toThrow('Failed to clone remote: NonExistentRemote');

      expect(notificationService.showError).toHaveBeenCalled();
    });
  });
  it('blocks save and navigation until initialization finishes', () => {
    setDialogData({ name: 'drive', remoteType: 'drive', editTarget: 'vfs' });
    service.editTarget.set('vfs');
    expect(service.isSaveDisabled()).toBe(true);
    expect(service.isStepClickable(2)).toBe(false);
    service.isInitializing.set(false);
    expect(service.isSaveDisabled()).toBe(false);
    service.initializationFailed.set(true);
    expect(service.isSaveDisabled()).toBe(true);
  });

  it('does not request operation flags when editing provider credentials', async () => {
    TestBed.inject(RemoteFacadeService).getRemote = vi
      .fn()
      .mockReturnValue({ config: { name: 'drive', type: 'drive' } });
    await service.init({ name: 'drive', remoteType: 'drive', editTarget: 'remote' });
    expect(TestBed.inject(FlagConfigService).loadConfigFields).not.toHaveBeenCalled();
  });

  it('passes provider overviews to the shared remote configuration step', async () => {
    const overview = { Tier: 'Tier 2', Features: ['Copy'], Hashes: ['md5'] };
    vi.mocked(TestBed.inject(RemoteManagementService).getRemoteTypes).mockResolvedValue([
      { name: 'drive', description: 'Google Drive', overview },
    ]);
    await service.init(undefined);
    expect(service.remoteTypes()).toEqual([{ value: 'drive', label: 'Google Drive', overview }]);
  });

  it('retains common serve options when subtype metadata is reconciled', () => {
    const options = service.remoteConfigForm.get('serveConfig.options') as FormGroup;
    const user = new FormControl("a'b,c", Validators.required);
    options.addControl('user', user);
    options.addControl('oldFlag', new FormControl('old'));
    service.dynamicServeFields.set([field('type', 'http'), field('user')]);
    service.rebuildServeOptionsGroup();
    expect(options.get('user')).toBe(user);
    expect(user.value).toBe("a'b,c");
    expect(user.hasValidator(Validators.required)).toBe(true);
    expect(options.get('oldFlag')).toBeNull();
  });
  it('keeps profile ownership consistent when selections overlap', async () => {
    service.initProfiles({ remoteType: 'drive' });
    service.remoteForm.patchValue({ name: 'drive', type: 'drive' });
    service.updateProfileConfig('vfs', 'A', { cache: 'a' });
    service.updateProfileConfig('vfs', 'B', { cache: 'b' });
    service.updateProfileConfig('vfs', 'C', { cache: 'c' });
    await service.selectProfile('vfs', 'A');
    const selectingB = service.selectProfile('vfs', 'B');
    const selectingC = service.selectProfile('vfs', 'C');
    await Promise.all([selectingB, selectingC]);
    expect(service.profiles().vfs['B']).toEqual({ cache: 'b' });
    expect(service.selectedProfileName().vfs).toBe('C');
    expect(service.remoteConfigForm.get('vfsConfig.options.cache')?.value).toBe('c');
  });

  it('loads the provider selection screen without unrelated operation flags', async () => {
    await service.init(undefined);
    expect(TestBed.inject(FlagConfigService).loadConfigFields).not.toHaveBeenCalled();
    expect(TestBed.inject(RemoteManagementService).getRemoteConfigFields).not.toHaveBeenCalled();
    service.currentStep.set(service.stepConfigs().findIndex(step => step.type === 'sync') + 1);
    await service.loadActiveProfile();
    expect(TestBed.inject(FlagConfigService).loadConfigFields).toHaveBeenCalledExactlyOnceWith([
      'sync',
    ]);
    expect(service.activeFieldsReady()).toBe(true);
  });

  it('retries every failed metadata resource before clearing the failure state', async () => {
    service.initProfiles({ remoteType: 'drive' });
    service.editTarget.set('vfs');
    service.remoteForm.patchValue({ type: 'drive' });
    const remoteFields = vi.mocked(TestBed.inject(RemoteManagementService).getRemoteConfigFields);
    const flags = vi.mocked(TestBed.inject(FlagConfigService).loadConfigFields);
    remoteFields.mockRejectedValueOnce(new Error('provider unavailable'));
    flags.mockRejectedValueOnce(new Error('flags unavailable'));
    await service.onRemoteTypeChange();
    await service.selectProfile('vfs', 'Default');
    expect(service.loadFailed()).toBe(true);
    await service.retryActiveFields();
    expect(remoteFields).toHaveBeenCalledTimes(2);
    expect(flags).toHaveBeenCalledTimes(2);
    expect(service.loadFailed()).toBe(false);
  });

  it('does not populate hidden linked forms when selecting an operation profile', async () => {
    service.initProfiles({ remoteType: 'drive' });
    service.remoteForm.patchValue({ type: 'drive' });
    service.updateProfileConfig('sync', 'Backup', { app: { filterProfile: 'Photos' } });
    service.updateProfileConfig('filter', 'Photos', { include: ['*.jpg'] });
    await service.selectProfile('sync', 'Backup');
    expect(service.selectedProfileName().filter).toBe('Photos');
    expect(TestBed.inject(FlagConfigService).loadConfigFields).toHaveBeenCalledExactlyOnceWith([
      'sync',
    ]);
    expect(TestBed.inject(RemoteManagementService).getRemoteConfigFields).not.toHaveBeenCalled();
  });

  it('includes stored linked profiles in template snapshots before their forms are opened', async () => {
    service.initProfiles({ remoteType: 'drive' });
    service.updateProfileConfig('mount', 'Default', { app: { filterProfile: 'Photos' } });
    service.updateProfileConfig('filter', 'Photos', { include: ['*.jpg'], custom: "a'b,c" });
    await service.selectProfile('mount', 'Default');
    const snapshot = service.getProfileTemplateValues('filter');
    expect(snapshot).toEqual({ include: ['*.jpg'], custom: "a'b,c" });
    expect(service.remoteConfigForm.get('filterConfig.options.include')).toBeNull();
    (snapshot['include'] as string[]).push('*.png');
    expect(service.profiles().filter['Photos']).toEqual({ include: ['*.jpg'], custom: "a'b,c" });
  });

  it('snapshots unsaved edits from the owning form instead of its stored profile', async () => {
    service.initProfiles({ remoteType: 'drive' });
    service.updateProfileConfig('filter', 'Photos', { include: ['*.jpg'] });
    await service.selectProfile('filter', 'Photos');
    service.remoteConfigForm.get('filterConfig.options.include')?.setValue(['*.png']);
    expect(service.getProfileTemplateValues('filter')).toEqual({ include: ['*.png'] });
    expect(service.profiles().filter['Photos']).toEqual({ include: ['*.jpg'] });
  });

  it('loads a saved serve subtype directly without first requesting HTTP flags', async () => {
    service.initProfiles({ remoteType: 'drive' });
    service.updateProfileConfig('serve', 'WebDAV', { rclone: { type: 'webdav', user: 'alice' } });
    await service.selectProfile('serve', 'WebDAV');
    expect(TestBed.inject(FlagConfigService).loadConfigFields).not.toHaveBeenCalled();
    expect(TestBed.inject(FlagConfigService).loadServeFlagFields).toHaveBeenCalledExactlyOnceWith(
      'webdav'
    );
    expect(service.remoteConfigForm.get('serveConfig.options.user')?.value).toBe('alice');
  });
  it('preserves saved credentials when their initial metadata request needs a retry', async () => {
    vi.mocked(TestBed.inject(RemoteFacadeService).getRemote).mockReturnValue({
      name: 'drive',
      type: 'drive',
      config: { name: 'drive', type: 'drive', token: "saved a'b,c" },
      status: createDefaultRemoteStatus(),
      features: createDefaultRemoteFeatures(),
      primaryActions: [],
      syncActions: [],
    });
    vi.mocked(TestBed.inject(RemoteManagementService).getRemoteConfigFields)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([field('token')]);
    await service.init({ name: 'drive', remoteType: 'drive', editTarget: 'remote' });
    expect(service.loadFailed()).toBe(true);
    await service.retryActiveFields();
    expect(service.loadFailed()).toBe(false);
    expect(service.remoteForm.get('token')?.value).toBe("saved a'b,c");
  });
});
