import { inject, Injectable } from '@angular/core';
import {
  profileOf,
  REMOTE_CONFIG_KEYS,
  type MountedRemote,
  type MountPathCollision,
} from '@app/types';
import { getFilename } from '../../shared/utils/path.utils';
import { PathService } from '../infrastructure/platform/path.service';
import { BackendService } from '../infrastructure/system/backend.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { FileSystemService } from './file-system.service';
import { MountManagementService } from './mount-management.service';

export function mountDriveLetter(path: unknown): string | undefined {
  if (typeof path !== 'string') return undefined;
  return /^[a-z]:[\\/]?$/i.test(path.trim()) ? path.trim().slice(0, 2).toUpperCase() : undefined;
}

function windowsFolderName(value: unknown): string | undefined {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || /[<>:"/\\|?*]/.test(name) || name.endsWith('.')) return undefined;
  if (Array.from(name).some(character => character.charCodeAt(0) < 32)) return undefined;
  const base = name.split('.', 1)[0].trimEnd();
  if (/^(con|prn|aux|nul|(?:com|lpt)[1-9¹²³])$/i.test(base)) return undefined;
  return name;
}

export function windowsMountFolderTarget(
  parent: string,
  previous: string,
  remoteName: string,
  diskName?: unknown
): string | undefined {
  const fallback = 'rclone-mount';
  if (!/^[a-z]:[\\/]/i.test(parent)) return undefined;
  const directory = parent.replaceAll('/', '\\').replace(/\\+$/, '');
  const oldTarget = previous.replaceAll('/', '\\').replace(/\\+$/, '');
  const previousName =
    /^[a-z]:\\./i.test(oldTarget) && oldTarget.toLowerCase() !== directory.toLowerCase()
      ? getFilename(oldTarget)
      : '';
  const existingName = previousName.toLowerCase() === fallback ? '' : previousName;
  const name =
    windowsFolderName(existingName) ??
    windowsFolderName(diskName) ??
    windowsFolderName(remoteName) ??
    fallback;
  return `${directory}\\${name}`;
}

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

  canCheck(): boolean {
    return this.files.canSelectDriveLetter();
  }

  async getDriveOptions(
    remote: string,
    profile: string | undefined,
    draftProfiles?: Record<string, unknown>,
    selectedLetter?: string
  ): Promise<MountDriveOption[]> {
    const scope = this.backend.activeBackend();
    const [freeLetters, cachedMounts, settings] = await Promise.all([
      this.files.getAvailableDriveLetters(),
      this.mounts.getMountedRemotes(),
      this.settings.getRemoteSettings(),
    ]);
    const checkScope = (): void => {
      if (scope !== this.backend.activeBackend() || !this.canCheck()) {
        throw new Error('Mount target backend changed');
      }
    };
    checkScope();
    const free = new Set(freeLetters);
    const isOwn = (mount: MountedRemote): boolean =>
      !!profile &&
      profileOf(mount) === profile &&
      this.paths.getRemoteNameFromFs(mount.fs) === remote;
    let mounts = cachedMounts;
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
    const draftSettings = draftProfiles
      ? {
          ...settings,
          [remote]: { ...settings[remote], [REMOTE_CONFIG_KEYS.mount]: draftProfiles },
        }
      : settings;

    return Array.from({ length: 26 }, (_, index): MountDriveOption => {
      const letter = String.fromCharCode(90 - index) + ':';
      const atLetter = mounts.filter(mount => mountDriveLetter(mount.mount_point) === letter);
      if (atLetter.some(mount => !isOwn(mount)) || (!free.has(letter) && !atLetter.some(isOwn))) {
        return { letter, status: 'occupied', availableForAutomatic: false };
      }
      const reservations = (profiles: typeof settings): MountPathCollision[] =>
        this.paths.checkMountPathCollision(letter, remote, profiles, profile, 'mount');

      // Compare against both the stored profiles and changes in the current editor.
      const collisions = [
        ...reservations(settings),
        ...(draftProfiles ? reservations(draftSettings) : []),
      ];
      const availableForAutomatic =
        letter[0] >= 'D' &&
        free.has(letter) &&
        atLetter.length === 0 &&
        !collisions.some(collision => collision.opType === 'mount');
      if (collisions.length > 0) {
        return { letter, status: 'reserved', availableForAutomatic };
      }
      return { letter, status: atLetter.some(isOwn) ? 'current' : 'free', availableForAutomatic };
    });
  }

  async changedDriveError(
    remote: string,
    profiles: Record<string, unknown> | undefined,
    baseline?: Record<string, unknown>
  ): Promise<{ key: string; params?: { letter: string } } | undefined> {
    try {
      const letter = await this.validateChangedDrives(remote, profiles, baseline);
      return letter
        ? { key: 'wizards.appOperation.mountDriveConflict', params: { letter } }
        : undefined;
    } catch {
      return { key: 'wizards.appOperation.mountDriveLettersUnavailable' };
    }
  }

  async validateChangedDrives(
    remote: string,
    profiles: Record<string, unknown> | undefined,
    baseline: Record<string, unknown> = {}
  ): Promise<string | undefined> {
    if (!profiles || !this.canCheck()) return undefined;
    const targetLetter = (value: unknown): string | undefined => {
      const config = value as
        | { rclone?: { mountPoint?: string }; mountPoint?: string; dest?: { path?: string } }
        | undefined;
      return mountDriveLetter(
        config?.rclone?.mountPoint ?? config?.mountPoint ?? config?.dest?.path
      );
    };
    for (const [profile, config] of Object.entries(profiles)) {
      const letter = targetLetter(config);
      if (!letter || letter === targetLetter(baseline[profile])) continue;
      const option = (await this.getDriveOptions(remote, profile, profiles)).find(
        option => option.letter === letter
      );
      if (option?.status !== 'free' && option?.status !== 'current') return letter;
    }
    return undefined;
  }
}
