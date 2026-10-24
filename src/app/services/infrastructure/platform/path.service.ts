import { Injectable, inject, signal } from '@angular/core';
import {
  ExplorerRoot,
  FileBrowserItem,
  PathGroup,
  PathGroupType,
  PathStyle,
  MountPathCollision,
} from '@app/types';
import { BackendService } from '../system/backend.service';
import * as pathUtils from '../../../shared/utils/path.utils';

@Injectable({ providedIn: 'root' })
export class PathService {
  private readonly remoteNames = signal(new Set<string>(), {
    equal: (a, b) => a.size === b.size && [...a].every(name => b.has(name)),
  });
  private readonly backendService = inject(BackendService);

  setRemoteNames(names: string[]): void {
    this.remoteNames.set(new Set(names.map(name => this.normalizeRemoteName(name))));
  }

  enginePathStyle(): PathStyle {
    return this.backendService.isWindows() ? 'windows' : 'posix';
  }

  pathStyleForRemote(remote: { isLocal: boolean } | null | undefined): PathStyle {
    if (!remote || remote.isLocal) return this.enginePathStyle();
    return 'posix';
  }

  normalizeForPlatform(path: string, pathStyle: PathStyle = this.enginePathStyle()): string {
    return pathUtils.normalizeForPlatform(path, pathStyle);
  }

  getParentPath(path: string, pathStyle: PathStyle = this.enginePathStyle()): string {
    return pathUtils.getParentPath(path, pathStyle);
  }

  normalizeRemoteForRclone(
    remoteName?: string,
    pathStyle: PathStyle = this.enginePathStyle()
  ): string {
    return pathUtils.normalizeRemoteForRclone(remoteName, pathStyle);
  }

  normalizeExplorerRoot(remote?: ExplorerRoot | null): string {
    return pathUtils.normalizeExplorerRoot(remote, this.enginePathStyle());
  }

  normalizeRemoteName(remoteName?: string, pathStyle: PathStyle = this.enginePathStyle()): string {
    return pathUtils.normalizeRemoteName(remoteName, pathStyle);
  }

  isLocalPath(path: string | string[]): boolean {
    return pathUtils.isLocalPath(path, this.remoteNames(), this.enginePathStyle());
  }

  isTrulyLocalPath(path: string, pathStyle: PathStyle = this.enginePathStyle()): boolean {
    return pathUtils.isTrulyLocalPath(path, this.remoteNames(), pathStyle);
  }

  splitFsPath(fullPath: string | string[]): { remote: string; path: string } {
    return pathUtils.splitFsPath(fullPath, this.remoteNames(), this.enginePathStyle());
  }

  splitLocalPath(
    path: string,
    pathStyle: PathStyle = this.enginePathStyle()
  ): { remote: string; remainder: string } {
    return pathUtils.splitLocalPath(path, pathStyle);
  }

  splitLocalForStat(
    path: string,
    pathStyle: PathStyle = this.enginePathStyle()
  ): { root: string; relative: string } {
    return pathUtils.splitLocalForStat(path, pathStyle);
  }

  getRemoteNameFromFs(fs: unknown): string {
    const normalized = pathUtils.normalizeFs(fs);
    if (!normalized) return '';
    if (this.isLocalPath(normalized)) return 'local';
    return this.normalizeRemoteName(normalized.split(':')[0]);
  }

  getFullDisplayPath(remote: ExplorerRoot | null, path: string, pathStyle?: PathStyle): string {
    return pathUtils.getFullDisplayPath(remote, path, pathStyle ?? this.pathStyleForRemote(remote));
  }

  parseFsString(
    fs: string,
    defaultType: 'local' | 'currentRemote' = 'local',
    currentRemoteName = '',
    existingRemotes: string[] = []
  ): PathGroup {
    if (!fs) return { type: defaultType, path: '', remote: '' };
    // During setup the current remote is not in the backend's remote list yet.
    const currentPrefix = currentRemoteName ? `${currentRemoteName}:` : '';
    const isWindowsDrive = this.enginePathStyle() === 'windows' && /^[a-z]:/i.test(fs);
    if (!isWindowsDrive && currentPrefix && fs.startsWith(currentPrefix)) {
      return { type: 'currentRemote', path: fs.slice(currentPrefix.length), remote: '' };
    }

    if (this.isLocalPath(fs)) {
      return { type: 'local', path: fs, remote: '' };
    }

    const colonIdx = fs.indexOf(':');
    if (colonIdx > -1) {
      const remote = fs.substring(0, colonIdx);
      const path = fs.substring(colonIdx + 1);
      if (remote === currentRemoteName) {
        return { type: 'currentRemote', path, remote: '' };
      }
      return { type: `otherRemote:${remote}`, path, remote };
    }

    if (existingRemotes.includes(fs)) {
      if (fs === currentRemoteName) {
        return { type: 'currentRemote', path: '', remote: '' };
      }
      return { type: `otherRemote:${fs}`, path: '', remote: fs };
    }

    return { type: 'local', path: fs, remote: '' };
  }

  resolvePathGroup(item: FileBrowserItem, currentRemoteName: string): PathGroup {
    const { isLocal, remote } = item.meta;
    const entryPath = item.entry.Path;

    if (isLocal) {
      const fullPath = pathUtils.joinPath(remote, entryPath);
      return { type: 'local', path: fullPath, remote: '' };
    }

    const normalizedRemote = this.normalizeRemoteName(remote);
    const normalizedCurrent = this.normalizeRemoteName(currentRemoteName);

    const type: PathGroupType =
      normalizedRemote === normalizedCurrent ? 'currentRemote' : `otherRemote:${normalizedRemote}`;

    return { type, path: entryPath, remote: normalizedRemote };
  }

  checkMountPathCollision(
    proposedPath: string,
    currentRemoteName: string,
    allSettings: Record<string, unknown> | undefined | null,
    currentProfileName?: string
  ): MountPathCollision[] {
    return pathUtils.checkMountPathCollision(
      proposedPath,
      currentRemoteName,
      allSettings,
      p => this.isLocalPath(p),
      currentProfileName
    );
  }
}
