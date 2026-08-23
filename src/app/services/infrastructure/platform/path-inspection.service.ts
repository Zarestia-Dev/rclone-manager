import { Injectable, inject, signal } from '@angular/core';
import { LocalDrive } from '@app/types';
import { ApiClientService } from './api-client.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { RemoteFileOperationsService } from '../../remote/remote-file-operations.service';
import { RemoteFacadeService } from '../../facade/remote-facade.service';
import { PathService, PathStyle } from './path.service';

export type DefaultPathOp = 'mount' | 'bisync';

export interface PathInspectionStatus {
  state: 'clean' | 'nonEmpty' | 'colliding' | 'willCreate' | 'checking';
  details?: string;
  icon: string;
  badgeClass: string;
  labelKey: string;
}

const MOUNT_TEMPLATE_FALLBACK = '{home}/rclone-manager/{remote}';
const BISYNC_TEMPLATE_FALLBACK = '{home}/rclone-manager/{remote}-bisync';
const HOME_FALLBACK_POSIX = '/root/rclone-manager';
const MAX_DEFAULT_PATH_ATTEMPTS = 10;

@Injectable({ providedIn: 'root' })
export class PathInspectionService {
  private readonly apiClient = inject(ApiClientService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly remoteFileOps = inject(RemoteFileOperationsService);
  private readonly remoteFacade = inject(RemoteFacadeService);
  private readonly pathService = inject(PathService);

  private readonly statuses = signal<Record<string, PathInspectionStatus>>({});
  private readonly checkingKeys = new Set<string>();

  /**
   * Get the inspection status of a local path.
   * If not cached, triggers background validation and returns a 'checking' status immediately.
   */
  getPathStatus(
    path: string | undefined | null,
    opType: string,
    remoteName: string
  ): PathInspectionStatus | null {
    if (!path || !path.trim()) {
      return null;
    }
    const trimmedPath = path.trim();
    const cacheKey = `${remoteName}:${opType}:${trimmedPath}`;

    const cached = this.statuses()[cacheKey];
    if (cached) {
      return cached;
    }

    this.triggerInspection(cacheKey, trimmedPath, remoteName);

    return {
      state: 'checking',
      icon: 'spinner',
      badgeClass: 'checking',
      labelKey: 'remoteConfig.pathStatus.checking',
    };
  }

  private async triggerInspection(key: string, path: string, remoteName: string): Promise<void> {
    if (this.checkingKeys.has(key)) return;
    this.checkingKeys.add(key);

    try {
      const status = await this.runInspection(path, remoteName);
      this.statuses.update(m => ({ ...m, [key]: status }));
    } catch {
      const fallback: PathInspectionStatus = {
        state: 'willCreate',
        icon: 'folder-plus',
        badgeClass: 'will-create',
        labelKey: 'remoteConfig.pathStatus.willCreate',
      };
      this.statuses.update(m => ({ ...m, [key]: fallback }));
    } finally {
      this.checkingKeys.delete(key);
    }
  }

  private async runInspection(path: string, remoteName: string): Promise<PathInspectionStatus> {
    // 1. Collision check (highest priority, synchronous)
    const collisions = this.remoteFacade.checkMountPathCollision(path, remoteName);
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

    // 2. Async check via Rclone API
    const { root, relative } = this.pathService.splitLocalForStat(path);
    try {
      const statRes = await this.remoteFileOps.getStat(root, relative);
      if (!statRes?.item) {
        return {
          state: 'willCreate',
          icon: 'folder-plus',
          badgeClass: 'will-create',
          labelKey: 'remoteConfig.pathStatus.willCreate',
        };
      }

      const sizeRes = await this.remoteFileOps.getSize(root, relative).catch(() => null);
      if (sizeRes && sizeRes.count > 0) {
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
      return {
        state: 'willCreate',
        icon: 'folder-plus',
        badgeClass: 'will-create',
        labelKey: 'remoteConfig.pathStatus.willCreate',
      };
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
    return this.ensureMountableDefault(normalized);
  }

  private async getPathTemplate(opType: DefaultPathOp): Promise<string> {
    const settingKey = opType === 'bisync' ? 'default_bisync_directory' : 'default_mount_directory';
    const fallback = opType === 'bisync' ? BISYNC_TEMPLATE_FALLBACK : MOUNT_TEMPLATE_FALLBACK;
    const stored = await this.appSettingsService.getSettingValue<string>(settingKey);
    return stored && stored.trim() ? stored : fallback;
  }

  private async resolveHome(): Promise<string> {
    try {
      const drives = await this.apiClient.invoke<LocalDrive[]>('get_local_drives');
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

  private async ensureMountableDefault(path: string): Promise<string> {
    const { root, relative } = this.pathService.splitLocalForStat(path);

    for (let attempt = 0; attempt < MAX_DEFAULT_PATH_ATTEMPTS; attempt++) {
      const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
      const candidate = `${path}${suffix}`;
      const candidateRel = `${relative}${suffix}`;

      try {
        const stat = await this.remoteFileOps.getStat(root, candidateRel);
        if (!stat?.item) {
          return candidate;
        }
        try {
          const size = await this.remoteFileOps.getSize(root, candidateRel);
          if (!size || size.count === 0) {
            return candidate;
          }
        } catch {
          return candidate;
        }
      } catch {
        return candidate;
      }
    }
    return path;
  }

  isTrulyLocalPath(
    path: string,
    pathStyle: PathStyle = this.pathService.enginePathStyle()
  ): boolean {
    return this.pathService.isTrulyLocalPath(path, pathStyle);
  }

  async createLocalDirectory(path: string, parentOnly = false): Promise<void> {
    if (!path) return;
    let targetPath = path;
    if (parentOnly) {
      targetPath = this.pathService.getParentPath(path);
      if (!targetPath) return;
    }
    const { root, relative } = this.pathService.splitLocalForStat(targetPath);
    try {
      await this.remoteFileOps.makeDirectory(root, relative);
    } catch (err) {
      console.error(`[PathInspectionService] Failed to create directory: ${targetPath}`, err);
    }
  }

  async createRequiredDirectories(settings: Record<string, unknown>): Promise<void> {
    const pathStyle = this.pathService.enginePathStyle();

    // 1. Handle Mount Configs
    const mountConfigs = (settings['mountConfigs'] as Record<string, unknown>) || {};
    for (const config of Object.values(mountConfigs) as {
      rclone?: { mountPoint?: string };
      mountPoint?: string;
    }[]) {
      const mountPoint = config?.rclone?.mountPoint || config?.mountPoint;
      if (
        mountPoint &&
        typeof mountPoint === 'string' &&
        this.isTrulyLocalPath(mountPoint, pathStyle)
      ) {
        await this.createLocalDirectory(mountPoint, pathStyle === 'windows');
      }
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

      if (path1 && typeof path1 === 'string' && this.isTrulyLocalPath(path1, pathStyle)) {
        await this.createLocalDirectory(path1, false);
      }
      if (path2 && typeof path2 === 'string' && this.isTrulyLocalPath(path2, pathStyle)) {
        await this.createLocalDirectory(path2, false);
      }
    }
  }
}
