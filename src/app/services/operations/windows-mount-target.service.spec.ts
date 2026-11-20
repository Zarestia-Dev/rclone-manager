import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type MountPathCollision } from '@app/types';
import { checkMountPathCollision } from '../../shared/utils/path.utils';
import { PathService } from '../infrastructure/platform/path.service';
import { BackendService } from '../infrastructure/system/backend.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { FileSystemService } from './file-system.service';
import { MountManagementService } from './mount-management.service';
import { WindowsMountTargetService } from './windows-mount-target.service';

describe('WindowsMountTargetService', () => {
  const profile = (mountPoint: string): object => ({ rclone: { mountPoint } });
  const settings = {
    vault: { mountConfigs: { Archive: profile('y:\\') } },
    office: { mountConfigs: { Main: profile('X:') } },
  };
  const physicalFree = vi.fn();
  const getSettings = vi.fn();
  const getMounts = vi.fn();
  let cachedMounts: object[] = [];
  const refreshMounts = vi.fn();
  let service: WindowsMountTargetService;

  beforeEach(() => {
    physicalFree.mockReset().mockResolvedValue(['Y:', 'W:', 'V:', 'U:']);
    getSettings.mockReset().mockResolvedValue(settings);
    refreshMounts.mockReset().mockResolvedValue(undefined);
    cachedMounts = [
      { mount_point: 'X:', fs: 'office:share', starter: { kind: 'profile', name: 'Main' } },
      { mount_point: 'U:', fs: 'office:', starter: { kind: 'profile', name: 'Other' } },
    ];
    getMounts.mockReset().mockImplementation(() => Promise.resolve(cachedMounts));
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
          useValue: {
            mountedRemotes: (): object[] => cachedMounts,
            getMountedRemotes: getMounts,
            forceCheckMountedRemotes: refreshMounts,
          },
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

  it('previews the automatic Z-to-D assignment as rclone makes it: free letters only, fixed profiles do not matter', async () => {
    physicalFree.mockResolvedValue(['Y:', 'X:', 'W:', 'C:', 'B:', 'A:']);
    const options = await service.getDriveOptions('office', 'Main');
    // X: is free for Windows but carries a running mount; A: to C: are never assigned.
    expect(
      options.filter(option => option.availableForAutomatic).map(option => option.letter)
    ).toEqual(['Y:', 'W:']);
    expect(options.find(option => option.letter === 'Y:')?.status).toBe('reserved');
    expect(options.find(option => option.letter === 'C:')?.status).toBe('free');
  });

  it('does not mistake the same profile name on another connection or a stale reservation for ownership', async () => {
    const other = await service.getDriveOptions('vault', 'Main');
    expect(other.find(o => o.letter === 'X:')?.status).toBe('occupied');

    cachedMounts = [];
    const stale = await service.getDriveOptions('office', 'Main');
    expect(stale.find(o => o.letter === 'X:')?.status).toBe('occupied');
  });

  it('refreshes a busy selected device when its cached mount is missing', async () => {
    const refreshed = cachedMounts;
    cachedMounts = [];
    refreshMounts.mockImplementationOnce(() => {
      cachedMounts = refreshed;
      return Promise.resolve();
    });
    const options = await service.getDriveOptions('office', 'Main', undefined, 'X:');
    expect(refreshMounts).toHaveBeenCalledOnce();
    expect(options.find(option => option.letter === 'X:')?.status).toBe('current');
  });

  it('keeps busy devices blocked when refresh fails or provides no matching profile', async () => {
    cachedMounts = [];
    refreshMounts.mockImplementationOnce(() => {
      cachedMounts = [{ mount_point: 'X:', fs: 'office:share' }];
      return Promise.resolve();
    });
    const unknown = await service.getDriveOptions('office', 'Main', undefined, 'X:');
    expect(unknown.find(option => option.letter === 'X:')?.status).toBe('occupied');

    cachedMounts = [];
    refreshMounts.mockRejectedValueOnce(new Error('Mount inventory unavailable'));
    const failed = await service.getDriveOptions('office', 'Main', undefined, 'X:');
    expect(failed.find(option => option.letter === 'X:')?.status).toBe('occupied');
  });

  it('does not refresh already known mounts or newly available letters', async () => {
    await service.getDriveOptions('office', 'Main', undefined, 'X:');
    await service.getDriveOptions('office', 'Main', undefined, 'W:');
    expect(refreshMounts).not.toHaveBeenCalled();
  });
});
