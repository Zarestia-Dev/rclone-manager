import { Injectable, inject, signal, computed, OnDestroy } from '@angular/core';
import { Location } from '@angular/common';
import { Subject } from 'rxjs';
import { PathSegment, PathService, PathStyle } from './path.service';

export interface NautilusLocation {
  /** Remote name as it appears in `ExplorerRoot.name` (e.g. `C:`, `/`, `googledrive`). */
  remote: string | null;
  /** Path relative to the remote root, or null if the URL has no path component. */
  path: string | null;
  /** True if the URL marks this window as a standalone nautilus window. */
  isStandalone: boolean;
}

@Injectable({ providedIn: 'root' })
export class PathNavigationService implements OnDestroy {
  private readonly location = inject(Location);
  private readonly pathService = inject(PathService);

  private _locationSubscription?: { unsubscribe(): void };

  private readonly _currentPath = signal<string>(this.location.path());
  readonly currentPath = this._currentPath.asReadonly();

  readonly currentLocation = computed<NautilusLocation>(() =>
    this.parseLocation(
      new URLSearchParams(window.location.search),
      this._currentPath(),
      window.location.hash
    )
  );

  private readonly _locationChanges = new Subject<NautilusLocation>();
  readonly locationChanges$ = this._locationChanges.asObservable();

  constructor() {
    this._locationSubscription = this.location.subscribe(() => {
      const newPath = this.location.path();
      this._currentPath.set(newPath);
      this._locationChanges.next(this.currentLocation());
    });
  }

  ngOnDestroy(): void {
    this._locationSubscription?.unsubscribe();
    this._locationChanges.complete();
  }

  /**
   * Encode a filesystem path for inclusion in a URL segment.
   *
   * Paths are always stored in canonical POSIX form internally; the `pathStyle`
   * parameter tells the encoder whether the *input* might contain Windows
   * backslashes that need normalising first.  Derived from
   * `PathService.pathStyleForRemote()` — never guessed from string shape.
   */
  encodePath(path: string, pathStyle: PathStyle = 'posix'): string {
    if (!path) return '';
    const normalized = pathStyle === 'windows' ? path.replace(/\\/g, '/') : path;
    const segments = this.pathService.splitSegments(normalized);
    const encoded = segments.map(seg => encodeURIComponent(seg));
    const joined = encoded.join('/');
    if (normalized.startsWith('/') && !joined.startsWith('/')) {
      return '/' + joined;
    }
    return joined;
  }

  decodePath(encoded: string): string {
    if (!encoded) return '';
    return this.pathService
      .splitSegments(encoded)
      .map(seg => {
        try {
          return decodeURIComponent(seg);
        } catch {
          return seg;
        }
      })
      .join('/');
  }

  encodeRemote(remote: string): string {
    return encodeURIComponent(remote);
  }

  decodeRemote(encoded: string): string {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }

  buildNautilusUrl(
    remote: string | null,
    path: string | null,
    pathStyle: PathStyle = 'posix'
  ): string {
    let url = `${window.location.origin}/nautilus`;
    if (remote) {
      url += `/${this.encodeRemote(remote)}`;
      if (path) {
        url += `/${this.encodePath(path, pathStyle)}`;
      }
    }
    return url;
  }

  buildRelativeNautilusPath(
    remote: string | null,
    path: string | null,
    pathStyle: PathStyle = 'posix'
  ): string {
    let url = '/nautilus';
    if (remote) {
      url += `/${this.encodeRemote(remote)}`;
      if (path) {
        url += `/${this.encodePath(path, pathStyle)}`;
      }
    }
    return url;
  }

  /**
   * Parse a nautilus URL back into remote + path.
   *
   * The `pathStyle` parameter controls drive-letter/POSIX-root recovery logic
   * and must come from `PathService.pathStyleForRemote()` for the target
   * remote — never inferred from the URL string itself.
   *
   * Default is `'posix'` because the recovery logic for Windows drive letters
   * is only relevant when the remote IS a local Windows drive; all other
   * remotes (SFTP, S3, Google Drive, etc.) use POSIX-style paths regardless
   * of the engine OS.
   */
  parseLocation(
    urlParams: URLSearchParams,
    pathName: string,
    hash: string,
    pathStyle: PathStyle = 'posix'
  ): NautilusLocation {
    const fromSegments = (input: string): NautilusLocation => {
      const stripped = input.replace(/^\/+/, '');
      const segments = this.pathService.splitSegments(stripped);
      const [first, ...rest] = segments;

      if (!first) {
        return { remote: null, path: null, isStandalone: false };
      }

      const decodedFirst = this.decodeRemote(first);

      // Defensive recovery: a previous encoder may have URL-encoded an entire
      // absolute path (e.g. `/home/user` or `C:\Users\Foo`) as a single
      // segment. We only split it when the engine-reported pathStyle tells us
      // the remote uses that style — never guessed from string shape alone.
      const isPosixAbsoluteFused = decodedFirst.startsWith('/');
      const isWindowsDriveFused = pathStyle === 'windows' && /^[a-zA-Z]:[\\/]/.test(decodedFirst);
      if (
        decodedFirst &&
        (isPosixAbsoluteFused || isWindowsDriveFused) &&
        this.pathService.splitSegments(decodedFirst).length > 1
      ) {
        let remoteName: string;
        let remainder: string;
        if (isPosixAbsoluteFused) {
          remoteName = '/';
          remainder = decodedFirst.replace(/^\/+/, '');
        } else {
          const reParsed = this.pathService.splitSegments(decodedFirst);
          remoteName = reParsed[0];
          remainder = reParsed.slice(1).join('/');
        }
        return {
          remote: remoteName,
          path: remainder || null,
          isStandalone: false,
        };
      }

      return {
        remote: decodedFirst,
        path: rest.length ? this.decodePath(rest.join('/')) : null,
        isStandalone: false,
      };
    };

    if (pathName.includes('/nautilus')) {
      const result = fromSegments(
        pathName.slice(pathName.indexOf('/nautilus') + '/nautilus'.length)
      );
      if (result.remote) return { ...result, isStandalone: true };
    }

    if (hash.startsWith('#/nautilus')) {
      const result = fromSegments(hash.slice('#/nautilus'.length));
      if (result.remote) return { ...result, isStandalone: true };
    }

    const browseRemote = urlParams.get('browse');
    if (browseRemote) {
      return {
        remote: browseRemote,
        path: urlParams.get('path'),
        isStandalone: false,
      };
    }

    return { remote: null, path: null, isStandalone: false };
  }

  parseCurrentLocation(): NautilusLocation {
    return this.parseLocation(
      new URLSearchParams(window.location.search),
      this.location.path(),
      window.location.hash
    );
  }

  navigateTo(remote: string | null, path: string | null, pathStyle: PathStyle = 'posix'): void {
    const url = this.buildRelativeNautilusPath(remote, path, pathStyle);
    this.location.go(url);
    this._currentPath.set(url);
  }

  replaceCurrent(remote: string | null, path: string | null, pathStyle: PathStyle = 'posix'): void {
    const url = this.buildRelativeNautilusPath(remote, path, pathStyle);
    this.location.replaceState(url);
    this._currentPath.set(url);
  }

  normalizePath(p: string): string {
    return this.pathService.normalizePath(p);
  }

  joinPath(...segments: string[]): string {
    return this.pathService.joinPath(...segments);
  }

  getParentPath(path: string, pathStyle?: PathStyle): string {
    return this.pathService.getParentPath(path, pathStyle);
  }

  getPathSegments(path: string): PathSegment[] {
    return this.pathService.getPathSegments(path);
  }

  splitSegments(path: string): string[] {
    return this.pathService.splitSegments(path);
  }

  toCanonicalSeparators(p: string): string {
    return p ? p.replace(/\\/g, '/') : p;
  }

  toNativeDisplay(canonicalPath: string, pathStyle: PathStyle = 'posix'): string {
    if (!canonicalPath) return canonicalPath;
    return pathStyle === 'windows' ? canonicalPath.replace(/\//g, '\\') : canonicalPath;
  }
}
