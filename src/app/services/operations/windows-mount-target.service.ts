import { inject, Injectable } from '@angular/core';
import { profileOf, REMOTE_CONFIG_KEYS, type MountedRemote } from '@app/types';
import { mountDriveLetter } from '../../shared/utils/path.utils';
import { PathService } from '../infrastructure/platform/path.service';
import { BackendService } from '../infrastructure/system/backend.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { FileSystemService } from './file-system.service';
import { MountManagementService } from './mount-management.service';

export interface MountDriveOption {
  letter: string;
  status: 'free' | 'current' | 'occupied' | 'reserved';
  availableForAutomatic: boolean;
}

@Injectable({ providedIn: 'root' })
export class WindowsMountTargetService {
  private readonly backend = inject(BackendService);
  private readonly files = inject(FileSystemService);
  private readonly mounts = inject(MountManagementService);
  private readonly paths = inject(PathService);
  private readonly settings = inject(AppSettingsService);

  async getDriveOptions(
    remote: string,
    profile: string | undefined,
    draftProfiles?: Record<string, unknown>,
    selectedLetter?: string
  ): Promise<MountDriveOption[]> {
    const scope = this.backend.activeBackend();
    const [freeLetters, settings] = await Promise.all([
      this.files.getAvailableDriveLetters(),
      this.settings.getRemoteSettings(),
    ]);
    const checkScope = (): void => {
      if (scope !== this.backend.activeBackend() || !this.files.canSelectDriveLetter()) {
        throw new Error('Mount target backend changed');
      }
    };
    checkScope();
    const free = new Set(freeLetters);
    const isOwn = (mount: MountedRemote): boolean =>
      !!profile &&
      profileOf(mount) === profile &&
      this.paths.getRemoteNameFromFs(mount.fs) === remote;
    // The signal follows the mount cache events; only a missing selected mount forces a refresh.
    let mounts = this.mounts.mountedRemotes();
    if (
      profile &&
      selectedLetter &&
      !free.has(selectedLetter) &&
      !mounts.some(mount => mountDriveLetter(mount.mount_point) === selectedLetter)
    ) {
      try {
        await this.mounts.forceCheckMountedRemotes();
        checkScope();
        mounts = await this.mounts.getMountedRemotes();
      } catch {
        // A failed refresh cannot establish ownership of an occupied letter.
      }
      checkScope();
    }
    const mountsByLetter = new Map<string, MountedRemote[]>();
    for (const mount of mounts) {
      const letter = mountDriveLetter(mount.mount_point);
      if (letter) mountsByLetter.set(letter, [...(mountsByLetter.get(letter) ?? []), mount]);
    }
    // The editor's profiles replace the stored ones of this remote, so a deleted or changed
    // profile no longer reserves its old letter.
    const effective = draftProfiles
      ? {
          ...settings,
          [remote]: { ...settings[remote], [REMOTE_CONFIG_KEYS.mount]: draftProfiles },
        }
      : settings;

    return Array.from({ length: 26 }, (_, index): MountDriveOption => {
      const letter = String.fromCharCode(90 - index) + ':';
      const atLetter = mountsByLetter.get(letter) ?? [];
      const ownsLetter = atLetter.some(isOwn);
      if (atLetter.some(mount => !isOwn(mount)) || (!free.has(letter) && !ownsLetter)) {
        return { letter, status: 'occupied', availableForAutomatic: false };
      }
      // rclone picks the first free letter from Z down to D for `*`.
      const availableForAutomatic = letter[0] >= 'D' && free.has(letter) && atLetter.length === 0;
      const reserved =
        this.paths.checkMountPathCollision(letter, remote, effective, profile, 'mount').length > 0;
      if (reserved) return { letter, status: 'reserved', availableForAutomatic };
      return { letter, status: ownsLetter ? 'current' : 'free', availableForAutomatic };
    });
  }
}
