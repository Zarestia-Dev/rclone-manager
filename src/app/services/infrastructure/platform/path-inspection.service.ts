import { Injectable, inject } from '@angular/core';
import {
  LocalDrive,
  DefaultPathOp,
  PathInspectionStatus,
  PathStyle,
  profileOf,
  REMOTE_CONFIG_KEYS,
} from '@app/types';
import { deepEqual } from '../../../shared/utils/deep-equal.util';
import { getRcloneCfg } from '../../../shared/utils/profile-config.util';
import { isWindowsMountNetworkPath, normalizeForPlatform } from '../../../shared/utils/path.utils';
import { TauriBaseService } from './tauri-base.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { RemoteFileOperationsService } from '../../remote/remote-file-operations.service';
import { MountManagementService } from '../../operations/mount-management.service';
import { BackendService } from '../system/backend.service';
import { PathService } from './path.service';

const MOUNT_TEMPLATE_FALLBACK = '{home}/rclone-manager/{remote}';
const BISYNC_TEMPLATE_FALLBACK = '{home}/rclone-manager/{remote}-bisync';
const HOME_FALLBACK_POSIX = '/root/rclone-manager';
const MAX_DEFAULT_PATH_ATTEMPTS = 10;

function windowsVolumeTarget(path: string): boolean {
  return /^[a-z]:[\\/]?$/i.test(path) || path === '*' || isWindowsMountNetworkPath(path);
}

function pathForInspection(path: string, pathStyle: PathStyle): string {
  // Windows Explorer's "Copy as path" surrounds an absolute path with quotes.
  return pathStyle === 'windows' ? path.replace(/^"([a-z]:[\\/][^"]+)"$/i, '$1') : path;
}

function fileTargetLabel(windowsMount: boolean): string {
  return windowsMount
    ? 'remoteConfig.pathStatus.notDirectoryWindowsMount'
    : 'remoteConfig.pathStatus.notDirectory';
}

export const PATH_INSPECTION_UNAVAILABLE: Readonly<PathInspectionStatus> = {
  state: 'unavailable',
  icon: 'warning',
  badgeClass: 'non-empty',
  labelKey: 'remoteConfig.pathStatus.unavailable',
};

@Injectable({ providedIn: 'root' })
export class PathInspectionService extends TauriBaseService {
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly remoteFileOps = inject(RemoteFileOperationsService);
  private readonly pathService = inject(PathService);
  private readonly mounts = inject(MountManagementService);
  private readonly backend = inject(BackendService);

  /**
   * Freshly inspects the given local path and returns its status.
   * No caching — callers are responsible for managing reactive state.
   */
  async inspect(
    path: string,
    remoteName: string,
    currentProfileName?: string,
    currentOperation?: DefaultPathOp
  ): Promise<PathInspectionStatus | null> {
    const pathStyle = this.pathService.enginePathStyle();
    const windowsMount = currentOperation === 'mount' && pathStyle === 'windows';
    const backendName = this.backend.activeBackend();
    // Automatic targets share no fixed drive letter to reserve.
    if (windowsMount && path === '*') return null;

    // Saved path collisions take precedence over filesystem inspection.
    const allSettings = await this.appSettingsService.getRemoteSettings();
    const collisions = this.pathService.checkMountPathCollision(
      path,
      remoteName,
      allSettings,
      currentProfileName,
      currentOperation
    );
    if (collisions.length > 0) {
      const c = collisions[0];
      return {
        state: 'colliding',
        details: `${c.remoteName} (${c.opType})`,
        icon: 'warning',
        badgeClass: 'colliding',
        labelKey: 'remoteConfig.pathStatus.colliding',
      };
    }

    // WinFsp's directory mount is a reparse point, which rclone stat can report as a file.
    if (
      windowsMount &&
      (windowsVolumeTarget(path) ||
        (await this.isOwnMountedFolder(path, remoteName, backendName, currentProfileName)))
    ) {
      return null;
    }

    const inspectedPath = pathForInspection(path, pathStyle);
    const { root, relative } = this.pathService.splitLocalForStat(inspectedPath);
    try {
      const statRes = await this.remoteFileOps.getStat(root, relative);
      if (!statRes || !Object.prototype.hasOwnProperty.call(statRes, 'item')) {
        throw new Error('Invalid path stat response');
      }
      if (inspectedPath !== path && statRes.item?.IsDir !== false) {
        return PATH_INSPECTION_UNAVAILABLE;
      }
      if (!statRes?.item) {
        return {
          state: 'willCreate',
          icon: 'folder-plus',
          badgeClass: 'will-create',
          labelKey: 'remoteConfig.pathStatus.willCreate',
        };
      }
      if (statRes.item.IsDir === false) {
        return {
          ...PATH_INSPECTION_UNAVAILABLE,
          state: 'notDirectory',
          labelKey: fileTargetLabel(windowsMount),
        };
      }
      if (statRes.item.IsDir !== true) {
        return PATH_INSPECTION_UNAVAILABLE;
      }

      if (windowsMount) {
        return {
          state: 'nonEmpty',
          icon: 'folder-open',
          badgeClass: 'non-empty',
          labelKey: 'wizards.appOperation.mountFolderAlreadyExists',
        };
      }

      if (!(await this.isDirectoryEmpty(root, relative))) {
        return {
          state: 'nonEmpty',
          icon: 'folder-open',
          badgeClass: 'non-empty',
          labelKey: 'remoteConfig.pathStatus.nonEmpty',
        };
      }

      return {
        state: 'clean',
        icon: 'check-circle',
        badgeClass: 'clean',
        labelKey: 'remoteConfig.pathStatus.clean',
      };
    } catch {
      return PATH_INSPECTION_UNAVAILABLE;
    }
  }

  /** Check before creating directories or persisting profiles. Only confirmed files block saving. */
  async profileFileError(
    settings: Record<string, unknown>,
    backendName: string,
    remoteName: string,
    baseline: Partial<Record<DefaultPathOp, Record<string, unknown>>> = {},
    editedProfile?: { operation: DefaultPathOp; name: string }
  ): Promise<string | undefined> {
    const pathStyle = this.pathService.enginePathStyle();
    for (const operation of ['mount', 'bisync'] as const) {
      const profiles = settings[REMOTE_CONFIG_KEYS[operation]] as
        Record<string, unknown> | undefined;
      const windowsMount = operation === 'mount' && pathStyle === 'windows';
      for (const [name, profile] of Object.entries(profiles ?? {})) {
        const explicitlyEdited =
          editedProfile?.operation === operation && editedProfile.name === name;
        if (!profile || (!explicitlyEdited && deepEqual(profile, baseline[operation]?.[name]))) {
          continue;
        }
        const config = getRcloneCfg(profile) ?? (profile as Record<string, unknown>);
        const paths =
          operation === 'mount' ? [config['mountPoint']] : [config['path1'], config['path2']];
        for (const value of paths) {
          if (typeof value !== 'string' || !value.trim()) continue;
          const target = value.trim();
          if (
            windowsMount &&
            (windowsVolumeTarget(target) ||
              (await this.isOwnMountedFolder(target, remoteName, backendName, name)))
          ) {
            continue;
          }
          const path = pathForInspection(target, pathStyle);
          if (await this.isFileTarget(path, operation, pathStyle, backendName)) {
            return fileTargetLabel(windowsMount);
          }
        }
      }
    }
    return undefined;
  }

  private async isOwnMountedFolder(
    path: string,
    remoteName: string,
    backendName: string,
    profileName?: string
  ): Promise<boolean> {
    if (!profileName || !remoteName || this.backend.activeBackend() !== backendName) return false;
    const normalize = (value: string): string =>
      normalizeForPlatform(value, 'windows').replace(/\\+$/, '').toLowerCase();
    const target = normalize(path);
    try {
      const mounts = await this.mounts.getMountedRemotes();
      return (
        this.backend.activeBackend() === backendName &&
        mounts.some(
          mount =>
            normalize(mount.mount_point) === target &&
            profileOf(mount) === profileName &&
            this.pathService.getRemoteNameFromFs(mount.fs) === remoteName
        )
      );
    } catch {
      return false;
    }
  }

  private async isFileTarget(
    path: string,
    operation: DefaultPathOp,
    pathStyle: PathStyle,
    backendName: string
  ): Promise<boolean> {
    let target: { root: string; relative: string };
    if (this.pathService.isTrulyLocalPath(path, pathStyle)) {
      target = this.pathService.splitLocalForStat(path, pathStyle);
    } else if (operation === 'bisync') {
      const { remote, path: relative } = this.pathService.splitFsPath(path);
      if (!remote || !relative) return false;
      target = { root: this.pathService.normalizeRemoteForRclone(remote), relative };
    } else {
      return false;
    }

    try {
      const { root, relative } = target;
      const stat = await this.remoteFileOps.getStat(
        root,
        relative,
        undefined,
        undefined,
        undefined,
        backendName
      );
      return stat?.item?.IsDir === false;
    } catch {
      return false;
    }
  }

  /**
   * Resolve a unique default local path for mount or bisync based on config templates.
   */
  async resolveDefaultPath(remoteName: string, opType: DefaultPathOp): Promise<string> {
    const [template, home] = await Promise.all([this.getPathTemplate(opType), this.resolveHome()]);
    const remote = this.sanitizeRemoteName(remoteName);
    const raw = this.substitute(template, home, remote);
    const normalized = this.pathService.normalizeForPlatform(raw);
    const requiresMissingTarget =
      opType === 'mount' && this.pathService.enginePathStyle() === 'windows';
    return this.ensureMountableDefault(normalized, requiresMissingTarget);
  }

  private async getPathTemplate(opType: DefaultPathOp): Promise<string> {
    const settingKey = opType === 'bisync' ? 'default_bisync_directory' : 'default_mount_directory';
    const fallback = opType === 'bisync' ? BISYNC_TEMPLATE_FALLBACK : MOUNT_TEMPLATE_FALLBACK;
    const stored = await this.appSettingsService.getSettingValue<string>(settingKey);
    return stored && stored.trim() ? stored : fallback;
  }

  private async resolveHome(): Promise<string> {
    try {
      const drives = await this.invokeCommand<LocalDrive[]>('get_local_drives');
      if (drives && drives.length > 0) {
        const first = drives[0];
        const candidate = first.name || first.mount_point || '';
        if (candidate) return candidate;
      }
    } catch (err) {
      console.warn('[PathInspectionService] Could not query Rclone local drives:', err);
    }
    return HOME_FALLBACK_POSIX;
  }

  private sanitizeRemoteName(remoteName: string): string {
    return (remoteName || 'cloud-remote').replace(/[:/\\]/g, '-');
  }

  private substitute(template: string, home: string, remote: string): string {
    return template.replace('{home}', home).replace('{remote}', remote);
  }

  private async isDirectoryEmpty(root: string, relative: string): Promise<boolean> {
    const response = await this.remoteFileOps.getRemotePaths(root, relative, { recurse: false });
    if (!Array.isArray(response?.list)) {
      throw new Error('Invalid directory listing response');
    }
    return response.list.length === 0;
  }

  private async ensureMountableDefault(
    path: string,
    requiresMissingTarget: boolean
  ): Promise<string> {
    const { root, relative } = this.pathService.splitLocalForStat(path);

    for (let attempt = 0; attempt < MAX_DEFAULT_PATH_ATTEMPTS; attempt++) {
      const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
      const candidate = `${path}${suffix}`;
      const candidateRel = `${relative}${suffix}`;

      const stat = await this.remoteFileOps.getStat(root, candidateRel);
      if (!stat || !Object.prototype.hasOwnProperty.call(stat, 'item')) {
        throw new Error('Invalid path stat response');
      }
      if (!stat?.item) return candidate;
      if (typeof stat.item.IsDir !== 'boolean') throw new Error('Invalid path stat response');
      if (
        !requiresMissingTarget &&
        stat.item.IsDir &&
        (await this.isDirectoryEmpty(root, candidateRel))
      ) {
        return candidate;
      }
    }
    throw new Error(JSON.stringify({ key: 'backendErrors.mount.directoryNotEmpty' }));
  }

  private async createLocalDirectory(
    path: unknown,
    pathStyle: PathStyle,
    parentOnly: boolean,
    backendName?: string
  ): Promise<void> {
    if (typeof path !== 'string' || !path || !this.pathService.isTrulyLocalPath(path, pathStyle))
      return;
    let targetPath = path;
    if (parentOnly) {
      if (windowsVolumeTarget(path)) return;
      targetPath = this.pathService.getParentPath(path, pathStyle);
      if (!targetPath) return;
    }
    const { root, relative } = this.pathService.splitLocalForStat(targetPath, pathStyle);
    await this.remoteFileOps.makeDirectory(root, relative, undefined, undefined, backendName);
  }

  async createRequiredDirectories(
    settings: Record<string, unknown>,
    backendName?: string
  ): Promise<void> {
    const pathStyle = this.pathService.enginePathStyle();

    // 1. Handle Mount Configs
    const mountConfigs = (settings['mountConfigs'] as Record<string, unknown>) || {};
    for (const config of Object.values(mountConfigs) as {
      rclone?: { mountPoint?: string };
      mountPoint?: string;
    }[]) {
      const mountPoint = config?.rclone?.mountPoint || config?.mountPoint;
      await this.createLocalDirectory(mountPoint, pathStyle, pathStyle === 'windows', backendName);
    }

    // 2. Handle Bisync Configs
    const bisyncConfigs = (settings['bisyncConfigs'] as Record<string, unknown>) || {};
    for (const config of Object.values(bisyncConfigs) as {
      rclone?: { path1?: string; path2?: string };
      path1?: string;
      path2?: string;
    }[]) {
      const path1 = config?.rclone?.path1 || config?.path1;
      const path2 = config?.rclone?.path2 || config?.path2;

      await this.createLocalDirectory(path1, pathStyle, false, backendName);
      await this.createLocalDirectory(path2, pathStyle, false, backendName);
    }
  }

  /**
   * Create required local directories for a single operation configuration (e.g. Quick Run).
   */
  async createRequiredDirectoriesForOperation(
    opType: string,
    rclone: Record<string, unknown>
  ): Promise<void> {
    if (!rclone) return;
    const pathStyle = this.pathService.enginePathStyle();

    if (opType === 'mount') {
      const mountPoint = rclone['mountPoint'] ?? rclone['dest'];
      await this.createLocalDirectory(mountPoint, pathStyle, pathStyle === 'windows');
    } else if (opType === 'bisync') {
      const path1 = rclone['path1'] ?? rclone['source'] ?? rclone['srcFs'];
      const path2 = rclone['path2'] ?? rclone['dest'] ?? rclone['dstFs'];
      await this.createLocalDirectory(path1, pathStyle, false);
      await this.createLocalDirectory(path2, pathStyle, false);
    }
  }
}
