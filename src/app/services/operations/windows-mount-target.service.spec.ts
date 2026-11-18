import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type MountPathCollision } from '@app/types';
import { checkMountPathCollision } from '../../shared/utils/path.utils';
import { PathService } from '../infrastructure/platform/path.service';
import { BackendService } from '../infrastructure/system/backend.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { FileSystemService } from './file-system.service';
import { MountManagementService } from './mount-management.service';
import {
  WindowsMountTargetService,
  mountDriveLetter,
  windowsMountFolderTarget,
} from './windows-mount-target.service';

describe('WindowsMountTargetService', () => {
  const profile = (mountPoint: string): object => ({ rclone: { mountPoint } });
  const settings = {
    vault: { mountConfigs: { Archive: profile('y:\\') } },
    office: { mountConfigs: { Main: profile('X:') } },
  };
  const physicalFree = vi.fn();
  const getSettings = vi.fn();
  const getMounts = vi.fn();
  const refreshMounts = vi.fn();
  let service: WindowsMountTargetService;

  beforeEach(() => {
    physicalFree.mockReset().mockResolvedValue(['Y:', 'W:', 'V:', 'U:']);
    getSettings.mockReset().mockResolvedValue(settings);
    refreshMounts.mockReset().mockResolvedValue(undefined);
    getMounts.mockReset().mockResolvedValue([
      { mount_point: 'X:', fs: 'office:share', starter: { kind: 'profile', name: 'Main' } },
      { mount_point: 'U:', fs: 'office:', starter: { kind: 'profile', name: 'Other' } },
    ]);
    TestBed.configureTestingModule({
      providers: [
        { provide: BackendService, useValue: { activeBackend: (): string => 'Local' } },
        {
          provide: FileSystemService,
          useValue: {
            canSelectDriveLetter: (): boolean => true,
            getAvailableDriveLetters: physicalFree,
          },
        },
        {
          provide: MountManagementService,
          useValue: { getMountedRemotes: getMounts, forceCheckMountedRemotes: refreshMounts },
        },
        { provide: AppSettingsService, useValue: { getRemoteSettings: getSettings } },
        {
          provide: PathService,
          useValue: {
            getRemoteNameFromFs: (fs: string): string => fs.split(':')[0],
            checkMountPathCollision: (
              letter: string,
              remote: string,
              config: Record<string, unknown>,
              name: string
            ): MountPathCollision[] =>
              checkMountPathCollision(letter, remote, config, () => true, name, {
                pathStyle: 'windows',
                currentOperation: 'mount',
              }),
          },
        },
      ],
    });
    service = TestBed.inject(WindowsMountTargetService);
  });

  it('recognizes a drive letter with optional trailing root separator and case', () => {
    expect(mountDriveLetter(' x:\\ ')).toBe('X:');
    expect(mountDriveLetter('Y:/')).toBe('Y:');
    expect(mountDriveLetter('D:\\Mounts')).toBeUndefined();
    expect(mountDriveLetter('*')).toBeUndefined();
    expect(mountDriveLetter(null)).toBeUndefined();
  });

  it('keeps the exact running profile and disables physical drives, other mounts and reservations', async () => {
    const options = await service.getDriveOptions('office', 'Main', {
      Main: profile('X:'),
      Draft: profile('V:'),
    });
    const status = (letter: string): string | undefined =>
      options.find(o => o.letter === letter)?.status;
    expect(options.map(o => o.letter).slice(0, 4)).toEqual(['Z:', 'Y:', 'X:', 'W:']);
    expect([
      status('C:'),
      status('X:'),
      status('Y:'),
      status('W:'),
      status('V:'),
      status('U:'),
    ]).toEqual(['occupied', 'current', 'reserved', 'free', 'reserved', 'occupied']);
  });

  it('does not mistake the same profile name on another connection or a stale reservation for ownership', async () => {
    const other = await service.getDriveOptions('vault', 'Main');
    expect(other.find(o => o.letter === 'X:')?.status).toBe('occupied');

    getMounts.mockResolvedValue([]);
    const stale = await service.getDriveOptions('office', 'Main');
    expect(stale.find(o => o.letter === 'X:')?.status).toBe('occupied');
  });

  it('uses an existing parent drive or folder without changing the draft subfolder name', () => {
    expect(windowsMountFolderTarget('D:/', '')).toBe('D:\\rclone-mount');
    expect(windowsMountFolderTarget('D:/Mounts/', 'C:\\Old\\Archív')).toBe('D:\\Mounts\\Archív');
    expect(windowsMountFolderTarget('C:\\', 'X:')).toBe('C:\\rclone-mount');
    expect(windowsMountFolderTarget('\\\\server\\share', '*')).toBeUndefined();
    expect(windowsMountFolderTarget('D:', '')).toBeUndefined();
  });

  it('refreshes a busy selected device when its cached mount is missing', async () => {
    getMounts.mockResolvedValueOnce([]);
    const options = await service.getDriveOptions('office', 'Main', undefined, 'X:');
    expect(refreshMounts).toHaveBeenCalledOnce();
    expect(options.find(option => option.letter === 'X:')?.status).toBe('current');
  });

  it('keeps busy devices blocked when refresh fails or provides no matching profile', async () => {
    getMounts
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ mount_point: 'X:', fs: 'office:share' }]);
    const unknown = await service.getDriveOptions('office', 'Main', undefined, 'X:');
    expect(unknown.find(option => option.letter === 'X:')?.status).toBe('occupied');

    getMounts.mockResolvedValue([]);
    refreshMounts.mockRejectedValueOnce(new Error('Mount inventory unavailable'));
    const failed = await service.getDriveOptions('office', 'Main', undefined, 'X:');
    expect(failed.find(option => option.letter === 'X:')?.status).toBe('occupied');
  });

  it('does not refresh already known mounts or newly available letters', async () => {
    await service.getDriveOptions('office', 'Main', undefined, 'X:');
    await service.getDriveOptions('office', 'Main', undefined, 'W:');
    expect(refreshMounts).not.toHaveBeenCalled();
  });

  it('rechecks at save and catches manual input and duplicates in the unsaved draft', async () => {
    const draft = { Main: profile('W:') };
    await expect(service.validateChangedDrives('office', draft)).resolves.toBeUndefined();
    physicalFree.mockResolvedValue(['Y:', 'V:']);
    await expect(service.validateChangedDrives('office', draft)).resolves.toBe('W:');
    await expect(service.validateChangedDrives('office', { Main: profile('y:\\') })).resolves.toBe(
      'Y:'
    );
    await expect(
      service.validateChangedDrives('office', {
        Main: profile('V:'),
        Other: profile('v:/'),
      })
    ).resolves.toBe('V:');
  });

  it('leaves unchanged targets and folder paths alone and fails closed if Windows availability fails', async () => {
    await expect(
      service.validateChangedDrives(
        'office',
        {
          Main: profile('X:'),
          Folder: profile('D:\\Mounts\\Office'),
        },
        { Main: profile('x:/') }
      )
    ).resolves.toBeUndefined();
    expect(physicalFree).not.toHaveBeenCalled();

    physicalFree.mockRejectedValue(new Error('Drive inventory unavailable'));
    await expect(service.validateChangedDrives('office', { Main: profile('W:') })).rejects.toThrow(
      'Drive inventory unavailable'
    );
  });
});
