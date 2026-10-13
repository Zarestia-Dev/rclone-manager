import { TestBed } from '@angular/core/testing';
import { FormBuilder } from '@angular/forms';
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
        {
          provide: PathService,
          useValue: {
            getRemoteNameFromFs: vi.fn(),
            parseFsString: vi.fn().mockReturnValue({ type: 'currentRemote', path: '', remote: '' }),
            buildPathString: vi.fn().mockReturnValue(''),
            buildPathStrings: vi.fn().mockReturnValue([]),
          },
        },
        {
          provide: PathInspectionService,
          useValue: {
            createRequiredDirectories: vi.fn().mockResolvedValue(undefined),
            resolveDefaultPath: vi.fn().mockResolvedValue('/default/path'),
          },
        },
        {
          provide: RcloneValueMapperService,
          useValue: {
            isDefaultValue: vi.fn().mockReturnValue(false),
          },
        },
        {
          provide: RemoteFacadeService,
          useValue: {
            loadRemotes: vi.fn().mockResolvedValue([]),
            activeRemotes: signal([]),
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
});
