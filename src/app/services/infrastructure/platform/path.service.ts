import { Injectable, inject } from '@angular/core';
import {
  ExplorerRoot,
  FileBrowserItem,
  PathGroup,
  PathGroupType,
  PathSegment,
  PathStyle,
  DefaultPathOp,
  PathInspectionStatus,
} from '@app/types';
import { BackendService } from '../system/backend.service';
import * as pathUtils from '../../../shared/utils/path.utils';

export type {
  PathSegment,
  PathStyle,
  PathGroupType,
  PathGroup,
  DefaultPathOp,
  PathInspectionStatus,
};

@Injectable({ providedIn: 'root' })
export class PathService {
  private readonly remoteNames = new Set<string>();
  private readonly backendService = inject(BackendService);

  setRemoteNames(names: string[]): void {
    this.remoteNames.clear();
    for (const name of names) {
      this.remoteNames.add(this.normalizeRemoteName(name));
    }
  }

  enginePathStyle(): PathStyle {
    return this.backendService.isWindows() ? 'windows' : 'posix';
  }

  pathStyleForRemote(remote: { isLocal: boolean } | null | undefined): PathStyle {
    if (!remote || remote.isLocal) return this.enginePathStyle();
    return 'posix';
  }

  normalizePath(p: string): string {
    return pathUtils.normalizePath(p);
  }

  normalizeForPlatform(path: string, pathStyle: PathStyle = this.enginePathStyle()): string {
    return pathUtils.normalizeForPlatform(path, pathStyle);
  }

  joinPath(...segments: string[]): string {
    return pathUtils.joinPath(...segments);
  }

  getFilename(path: string): string {
    return pathUtils.getFilename(path);
  }

  getDirname(path: string): string {
    return pathUtils.getDirname(path);
  }

  getParentPath(path: string, pathStyle: PathStyle = this.enginePathStyle()): string {
    return pathUtils.getParentPath(path, pathStyle);
  }

  getPathSegments(path: string): PathSegment[] {
    return pathUtils.getPathSegments(path);
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
    return pathUtils.isLocalPath(path, this.remoteNames, this.enginePathStyle());
  }

  isTrulyLocalPath(path: string, pathStyle: PathStyle = this.enginePathStyle()): boolean {
    return pathUtils.isTrulyLocalPath(path, this.remoteNames, pathStyle);
  }

  splitFsPath(fullPath: string | string[]): { remote: string; path: string } {
    return pathUtils.splitFsPath(fullPath, this.remoteNames, this.enginePathStyle());
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

  normalizeFs(fs: unknown): string {
    return pathUtils.normalizeFs(fs);
  }

  getRemoteNameFromFs(fs: unknown): string {
    const normalized = this.normalizeFs(fs);
    if (!normalized) return '';
    if (this.isLocalPath(normalized)) return 'local';
    return this.normalizeRemoteName(normalized.split(':')[0]);
  }

  buildPathString(pathGroup: PathGroup | string, currentRemoteName: string): string {
    return pathUtils.buildPathString(pathGroup, currentRemoteName);
  }

  buildPathStrings(
    pathGroups: PathGroup | PathGroup[] | null | undefined,
    currentRemoteName: string
  ): string[] {
    return pathUtils.buildPathStrings(pathGroups, currentRemoteName);
  }

  parsePathType(value: string): 'local' | 'currentRemote' | 'otherRemote' {
    return pathUtils.parsePathType(value);
  }

  getRemoteNameFromValue(value: string, currentRemoteName: string): string | null {
    return pathUtils.getRemoteNameFromValue(value, currentRemoteName);
  }

  getFullDisplayPath(remote: ExplorerRoot | null, path: string, pathStyle?: PathStyle): string {
    return pathUtils.getFullDisplayPath(remote, path, pathStyle ?? this.pathStyleForRemote(remote));
  }

  getDisplaySegment(remote: ExplorerRoot | null, path: string, fallback = ''): string {
    return pathUtils.getDisplaySegment(remote, path, fallback);
  }

  extractName(path: string, remoteName?: string): string {
    return pathUtils.extractName(path, remoteName);
  }

  splitSegments(path: string): string[] {
    return pathUtils.splitSegments(path);
  }

  isMultiPath(path: string | string[]): boolean {
    return pathUtils.isMultiPath(path);
  }

  asPathArray(path: string | string[]): string[] {
    return pathUtils.asPathArray(path);
  }

  getPrimaryPath(path: string | string[]): string {
    return pathUtils.getPrimaryPath(path);
  }

  formatPathDisplay(path: string | string[]): string {
    return pathUtils.formatPathDisplay(path);
  }

  formatPathTooltip(path: string | string[]): string {
    return pathUtils.formatPathTooltip(path);
  }

  parseLocation(
    rawInput: string,
    knownRemotes: ExplorerRoot[]
  ): { remote: ExplorerRoot; path: string } | null {
    return pathUtils.parseLocation(rawInput, knownRemotes);
  }

  parseFsString(
    fs: string,
    defaultType: 'local' | 'currentRemote' = 'local',
    currentRemoteName = '',
    existingRemotes: string[] = []
  ): PathGroup {
    if (!fs) return { type: defaultType, path: '', remote: '' };

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
      const fullPath = this.joinPath(remote, entryPath);
      return { type: 'local', path: fullPath, remote: '' };
    }

    const normalizedRemote = this.normalizeRemoteName(remote);
    const normalizedCurrent = this.normalizeRemoteName(currentRemoteName);

    const type: PathGroupType =
      normalizedRemote === normalizedCurrent ? 'currentRemote' : `otherRemote:${normalizedRemote}`;

    return { type, path: entryPath, remote: normalizedRemote };
  }
}
