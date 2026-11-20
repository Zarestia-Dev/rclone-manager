import { Injectable, inject } from '@angular/core';
import { LocalDrive, DefaultPathOp, PathInspectionStatus, PathStyle, profileOf } from '@app/types';
import {
  isWindowsMountNetworkPath,
  mountDriveLetter,
  normalizeForPlatform,
  unquoteWindowsPath,
} from '../../../shared/utils/path.utils';
import { TauriBaseService } from './tauri-base.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { RemoteFileOperationsService } from '../../remote/remote-file-operations.service';
import { MountManagementService } from '../../operations/mount-management.service';
import { QuickRunService } from '../../flow/quick-run.service';
import { PathService } from './path.service';

const MOUNT_TEMPLATE_FALLBACK = '{home}/rclone-manager/{remote}';
const BISYNC_TEMPLATE_FALLBACK = '{home}/rclone-manager/{remote}-bisync';
const HOME_FALLBACK_POSIX = '/root/rclone-manager';
const MAX_DEFAULT_PATH_ATTEMPTS = 10;

function windowsVolumeTarget(path: string): boolean {
  return !!mountDriveLetter(path) || path === '*' || isWindowsMountNetworkPath(path);
}

function pathForInspection(path: string, pathStyle: PathStyle): string {
  return pathStyle === 'windows' ? unquoteWindowsPath(path) : path;
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

const INSPECTION_PAUSE_MS = 300;

/**
 * Inspects a path once the user has paused typing. It reports a "checking" status first and then
 * the answer, or `PATH_INSPECTION_UNAVAILABLE` when the check fails. The returned function cancels
 * the pending check; call it whenever the path changes or the field goes away.
 */
export function inspectAfterPause(
  inspector: Pick<PathInspectionService, 'inspect'>,
  request: {
    path: string;
    remoteName: string;
    profileName?: string;
    operation?: DefaultPathOp;
    quickRunId?: string | null;
  },
  report: (status: PathInspectionStatus | null) => void
): () => void {
  let cancelled = false;
  const timer = setTimeout(() => {
    report({
      state: 'checking',
      icon: 'spinner',
      badgeClass: 'checking',
      labelKey: 'remoteConfig.pathStatus.checking',
    });
    inspector
      .inspect(
        request.path,
        request.remoteName,
        request.profileName,
        request.operation,
        request.quickRunId
      )
      .catch(() => PATH_INSPECTION_UNAVAILABLE)
      .then(status => {
        if (!cancelled) report(status);
      });
  }, INSPECTION_PAUSE_MS);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}

@Injectable({ providedIn: 'root' })
export class PathInspectionService extends TauriBaseService {
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly remoteFileOps = inject(RemoteFileOperationsService);
  private readonly pathService = inject(PathService);
  private readonly mounts = inject(MountManagementService);
  private readonly quickRuns = inject(QuickRunService);

  /**
   * Freshly inspects the given path and returns its status.
   * No caching — callers are responsible for managing reactive state. The profile or Quick Run
   * being edited does not collide with itself.
   */
  async inspect(
    path: string,
    remoteName: string,
    currentProfileName?: string,
    currentOperation?: DefaultPathOp,
    currentQuickRunId?: string | null
  ): Promise<PathInspectionStatus | null> {
    const pathStyle = this.pathService.enginePathStyle();
    const windowsMount = currentOperation === 'mount' && pathStyle === 'windows';
    // Automatic targets share no fixed drive letter to reserve.
    if (windowsMount && path === '*') return null;

    // Saved path collisions take precedence over filesystem inspection.
    const allSettings = await this.appSettingsService.getRemoteSettings();
    const collisions = this.pathService.checkMountPathCollision(
      path,
      remoteName,
      allSettings,
      currentProfileName,
      currentOperation,
      { runs: this.quickRuns.quickRuns(), exceptId: currentQuickRunId }
    );
    if (collisions.length > 0) {
      const { kind, name, remoteName: owner } = collisions[0];
      return {
        state: 'colliding',
        icon: 'warning',
        badgeClass: 'colliding',
        labelKey:
          kind === 'quick_run'
            ? 'remoteConfig.pathStatus.collidingQuickRun'
            : 'remoteConfig.pathStatus.collidingProfile',
        labelParams: { name, remote: owner },
      };
    }

    // WinFsp's directory mount is a reparse point, which rclone stat can report as a file.
    if (
      windowsMount &&
      (windowsVolumeTarget(path) || this.isOwnMountedFolder(path, remoteName, currentProfileName))
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
          state: 'exists',
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

  /** Reads the live mount cache signal: no IPC per keystroke. */
  private isOwnMountedFolder(path: string, remoteName: string, profileName?: string): boolean {
    if (!profileName || !remoteName) return false;
    const normalize = (value: string): string =>
      normalizeForPlatform(value, 'windows').replace(/\\+$/, '').toLowerCase();
    const target = normalize(path);
    return this.mounts
      .mountedRemotes()
      .some(
        mount =>
          normalize(mount.mount_point) === target &&
          profileOf(mount) === profileName &&
          this.pathService.getRemoteNameFromFs(mount.fs) === remoteName
      );
  }

  /**
   * Resolve a unique default local path for mount or bisync based on config templates. A folder
   * that a saved profile or Quick Run already uses is skipped, like one that is not empty.
   */
  async resolveDefaultPath(remoteName: string, opType: DefaultPathOp): Promise<string> {
    const [template, home, saved] = await Promise.all([
      this.getPathTemplate(opType),
      this.resolveHome(),
      this.appSettingsService.getRemoteSettings(),
    ]);
    const usedBySaved = (candidate: string): boolean =>
      this.pathService.checkMountPathCollision(candidate, remoteName, saved, undefined, opType, {
        runs: this.quickRuns.quickRuns(),
      }).length > 0;
    const remote = this.sanitizeRemoteName(remoteName);
    const raw = this.substitute(template, home, remote);
    const normalized = this.pathService.normalizeForPlatform(raw);
    const requiresMissingTarget =
      opType === 'mount' && this.pathService.enginePathStyle() === 'windows';
    return this.ensureMountableDefault(normalized, requiresMissingTarget, usedBySaved);
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
    requiresMissingTarget: boolean,
    usedBySaved: (candidate: string) => boolean
  ): Promise<string> {
    const { root, relative } = this.pathService.splitLocalForStat(path);

    for (let attempt = 0; attempt < MAX_DEFAULT_PATH_ATTEMPTS; attempt++) {
      const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
      const candidate = `${path}${suffix}`;
      const candidateRel = `${relative}${suffix}`;
      if (usedBySaved(candidate)) continue;

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
