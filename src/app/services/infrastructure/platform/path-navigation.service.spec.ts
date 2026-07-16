/**
 * Unit tests for PathNavigationService — the canonical URL encode/decode
 * utility, parameterized by the engine-reported OS via `PathService`.
 *
 * Covers all four real-world path-style combinations:
 *
 *   1. Local Windows path  (engine on Windows, remote = `C:` drive)
 *   2. Local POSIX path    (engine on Linux,   remote = `/`)
 *   3. SFTP remote         (POSIX-style regardless of client/engine OS)
 *   4. S3 / Google Drive   (POSIX-style regardless of client/engine OS)
 *
 * For each, we verify:
 *   - URL encode → decode round-trip preserves the path
 *   - buildRelativeNautilusPath → parseLocation round-trips (browser back/forward/reload)
 *   - toNativeDisplay renders in the remote's native form
 */
import { TestBed } from '@angular/core/testing';
import { Location, LocationStrategy, PathLocationStrategy } from '@angular/common';
import { PathNavigationService } from './path-navigation.service';
import { PathService } from './path.service';
import { BackendService } from '../system/backend.service';
import { ApiClientService } from './api-client.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { RemoteFileOperationsService } from '../../remote/remote-file-operations.service';
import { Injector, signal } from '@angular/core';

function setupBackend(os: 'linux' | 'windows'): {
  backend: Record<string, unknown>;
  setOs: (os: string) => void;
} {
  const backends = signal([
    { name: 'Local', isLocal: true, os } as { name: string; isLocal: boolean; os: string },
  ]);
  const activeBackend = signal('Local');
  const isWindows = signal(os === 'windows');
  return {
    backend: { backends, activeBackend, isWindows },
    setOs: (newOs: string): void => {
      backends.set([{ name: 'Local', isLocal: true, os: newOs }]);
      isWindows.set(newOs.includes('windows'));
    },
  };
}

function stubService(): Record<string, unknown> {
  return {};
}

describe('PathNavigationService', () => {
  let service: PathNavigationService;
  let pathService: PathService;

  function configureWithOs(os: 'linux' | 'windows'): void {
    const mock = setupBackend(os);
    TestBed.configureTestingModule({
      providers: [
        Location,
        { provide: LocationStrategy, useClass: PathLocationStrategy },
        PathService,
        PathNavigationService,
        { provide: BackendService, useValue: mock.backend },
        { provide: ApiClientService, useValue: stubService() },
        { provide: AppSettingsService, useValue: stubService() },
        { provide: RemoteFileOperationsService, useValue: stubService() },
        { provide: Injector, useValue: { get: (): Record<string, unknown> => stubService() } },
      ],
    });
    service = TestBed.inject(PathNavigationService);
    pathService = TestBed.inject(PathService);
  }

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('should be created', () => {
    configureWithOs('linux');
    expect(service).toBeTruthy();
  });

  // ───────────────────────────────────────────────────────────────────────
  // SCENARIO 1: Local Windows path (engine on Windows, remote = C:)
  // ───────────────────────────────────────────────────────────────────────

  describe('Scenario 1: Local Windows path (engine=windows, remote=C:)', () => {
    beforeEach(() => configureWithOs('windows'));

    it('encodePath: Windows input → canonical POSIX URL form', () => {
      // Caller passes pathStyle='windows' so the encoder normalizes backslashes.
      // The colon in `C:` is percent-encoded per RFC 3986 (reserved char) —
      // that's URL-correctness, not OS-inference.
      expect(service.encodePath('Users\\Foo', 'windows')).toBe('Users/Foo');
      expect(service.encodePath('C:\\Users\\Foo', 'windows')).toBe('C%3A/Users/Foo');
      expect(service.encodePath('My Docs/file #1.txt', 'windows')).toBe(
        'My%20Docs/file%20%231.txt'
      );
    });

    it('encodePath: POSIX-canonical input (no pathStyle) is left alone (modulo URL-encoding of reserved chars)', () => {
      // Internal callers always pass canonical POSIX; no backslash conversion
      // happens. Reserved URL chars in individual segments (e.g. `:` in `C:`)
      // are still percent-encoded per RFC 3986 — that's correct URL behavior,
      // not an OS-inference artifact.
      expect(service.encodePath('Users/Foo')).toBe('Users/Foo');
      expect(service.encodePath('C:/Users/Foo')).toBe('C%3A/Users/Foo');
    });

    it('decodePath: URL-encoded Windows path → canonical POSIX', () => {
      expect(service.decodePath('Users/Foo')).toBe('Users/Foo');
      expect(service.decodePath('My%20Docs/file%20%231.txt')).toBe('My Docs/file #1.txt');
    });

    it('full URL round-trip: build → parse → build is idempotent', () => {
      const remote = 'C:';
      const path = 'Users/Name/Folder';
      const built = service.buildRelativeNautilusPath(remote, path, 'windows');
      const parsed = service.parseLocation(new URLSearchParams(), built, '', 'windows');
      expect(parsed.remote).toBe(remote);
      expect(parsed.path).toBe(path);
      expect(
        service.buildRelativeNautilusPath(parsed.remote ?? '', parsed.path ?? '', 'windows')
      ).toBe(built);
    });

    it('toNativeDisplay: canonical POSIX → Windows backslashes', () => {
      expect(service.toNativeDisplay('C:/Users/Foo', 'windows')).toBe('C:\\Users\\Foo');
      expect(service.toNativeDisplay('Users/Foo', 'windows')).toBe('Users\\Foo');
    });

    it('defensively recovers a single-segment URL-encoded drive path (pathStyle=windows)', () => {
      // Legacy URL form: `/nautilus/C%3A%5CUsers%5CFoo` (the whole `C:\Users\Foo`
      // was URL-encoded as one segment). Drive-letter recovery only fires
      // when pathStyle='windows' is explicitly passed — the default is
      // 'posix' because most remotes are POSIX-style regardless of engine OS.
      const loc = service.parseLocation(
        new URLSearchParams(),
        '/nautilus/C%3A%5CUsers%5CFoo',
        '',
        'windows'
      );
      expect(loc.remote).toBe('C:');
      expect(loc.path).toBe('Users/Foo');
    });

    it('does NOT apply drive-letter recovery when pathStyle is POSIX (default)', () => {
      // Without explicit pathStyle='windows', the default is 'posix', so
      // `C:\Users\Foo` is treated as a single remote name, not split.
      const loc = service.parseLocation(new URLSearchParams(), '/nautilus/C%3A%5CUsers%5CFoo', '');
      expect(loc.remote).toBe('C:\\Users\\Foo');
      expect(loc.path).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // SCENARIO 2: Local POSIX path (engine on Linux, remote = /)
  // ───────────────────────────────────────────────────────────────────────

  describe('Scenario 2: Local POSIX path (engine=linux, remote=/)', () => {
    beforeEach(() => configureWithOs('linux'));

    it('encodePath: POSIX-absolute path keeps leading slash', () => {
      expect(service.encodePath('/home/user/folder')).toBe('/home/user/folder');
      expect(service.encodePath('/home/user/folder').startsWith('/')).toBe(true);
    });

    it('encodePath: POSIX relative path has no leading slash', () => {
      expect(service.encodePath('relative/path')).toBe('relative/path');
    });

    it('decodePath: round-trips POSIX path (leading slash not preserved — splitSegments filters empties)', () => {
      // encodePath re-adds the leading slash for POSIX-absolute inputs, but
      // decodePath runs splitSegments which treats `/` as an empty leading
      // segment and filters it out. This is pre-existing behavior; the
      // canonical POSIX form is recoverable from parseLocation (which knows
      // the remote is `/`) rather than from decodePath alone.
      const encoded = service.encodePath('/home/user/folder');
      expect(encoded).toBe('/home/user/folder');
      expect(service.decodePath(encoded)).toBe('home/user/folder');
    });

    it('full URL round-trip: build → parse → build is idempotent', () => {
      const remote = '/';
      const path = 'home/user/folder';
      const built = service.buildRelativeNautilusPath(remote, path);
      const parsed = service.parseLocation(new URLSearchParams(), built, '');
      expect(parsed.remote).toBe(remote);
      expect(parsed.path).toBe(path);
      expect(service.buildRelativeNautilusPath(parsed.remote ?? '', parsed.path ?? '')).toBe(built);
    });

    it('toNativeDisplay: POSIX style is identity', () => {
      expect(service.toNativeDisplay('/home/user', 'posix')).toBe('/home/user');
      expect(service.toNativeDisplay('Photos/2024', 'posix')).toBe('Photos/2024');
    });

    it('defensively recovers a single-segment URL-encoded POSIX absolute path', () => {
      const loc = service.parseLocation(new URLSearchParams(), '/nautilus/%2Fhome%2Fuser', '');
      expect(loc.remote).toBe('/');
      expect(loc.path).toBe('home/user');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // SCENARIO 3: SFTP remote (POSIX-style regardless of engine OS)
  // ───────────────────────────────────────────────────────────────────────

  describe('Scenario 3: SFTP remote (POSIX-style regardless of engine OS)', () => {
    it('uses POSIX canonical form when engine is Windows', () => {
      configureWithOs('windows');
      const remote = 'my-sftp';
      const path = 'etc/passwd';
      const built = service.buildRelativeNautilusPath(remote, path);
      expect(built).toBe('/nautilus/my-sftp/etc/passwd');
      const parsed = service.parseLocation(new URLSearchParams(), built, '');
      expect(parsed.remote).toBe(remote);
      expect(parsed.path).toBe(path);
    });

    it('uses POSIX canonical form when engine is Linux', () => {
      configureWithOs('linux');
      const remote = 'my-sftp';
      const path = 'var/log/syslog';
      const built = service.buildRelativeNautilusPath(remote, path);
      expect(built).toBe('/nautilus/my-sftp/var/log/syslog');
      const parsed = service.parseLocation(new URLSearchParams(), built, '');
      expect(parsed.remote).toBe(remote);
      expect(parsed.path).toBe(path);
    });

    it('pathStyleForRemote reports POSIX for SFTP regardless of engine OS', () => {
      configureWithOs('windows');
      expect(pathService.pathStyleForRemote({ isLocal: false })).toBe('posix');
    });

    it('pathStyleForRemote reports POSIX for SFTP on Linux engine too', () => {
      configureWithOs('linux');
      expect(pathService.pathStyleForRemote({ isLocal: false })).toBe('posix');
    });

    it('toNativeDisplay renders forward slashes even when engine is Windows', () => {
      configureWithOs('windows');
      // Caller explicitly passes POSIX (derived from pathStyleForRemote).
      expect(service.toNativeDisplay('etc/passwd', 'posix')).toBe('etc/passwd');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // SCENARIO 4: S3 / Google Drive remote (POSIX-style regardless of engine OS)
  // ───────────────────────────────────────────────────────────────────────

  describe('Scenario 4: S3 / Google Drive remote (POSIX-style regardless of engine OS)', () => {
    it('bucket-based path round-trips through URL encode/decode', () => {
      configureWithOs('linux');
      const remote = 'my-s3';
      const path = 'bucket/folder/object.txt';
      const built = service.buildRelativeNautilusPath(remote, path);
      expect(built).toBe('/nautilus/my-s3/bucket/folder/object.txt');
      const parsed = service.parseLocation(new URLSearchParams(), built, '');
      expect(parsed).toEqual({
        remote: 'my-s3',
        path: 'bucket/folder/object.txt',
        isStandalone: true,
      });
    });

    it('Google Drive path round-trips through URL encode/decode', () => {
      configureWithOs('windows');
      const remote = 'googledrive';
      const path = 'Photos/2024/album';
      const built = service.buildRelativeNautilusPath(remote, path);
      expect(built).toBe('/nautilus/googledrive/Photos/2024/album');
      const parsed = service.parseLocation(new URLSearchParams(), built, '');
      expect(parsed).toEqual({
        remote: 'googledrive',
        path: 'Photos/2024/album',
        isStandalone: true,
      });
    });

    it('path with special URL characters round-trips', () => {
      configureWithOs('linux');
      const remote = 'googledrive';
      const path = 'My Docs/file #1.txt? & more';
      const built = service.buildRelativeNautilusPath(remote, path);
      const parsed = service.parseLocation(new URLSearchParams(), built, '');
      expect(parsed.remote).toBe(remote);
      expect(parsed.path).toBe(path);
    });

    it('path with Unicode characters round-trips', () => {
      configureWithOs('linux');
      const remote = 'googledrive';
      const path = '文件夹/文件.txt';
      const built = service.buildRelativeNautilusPath(remote, path);
      const parsed = service.parseLocation(new URLSearchParams(), built, '');
      expect(parsed.remote).toBe(remote);
      expect(parsed.path).toBe(path);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Browser back/forward + reload simulation
  // ───────────────────────────────────────────────────────────────────────

  describe('browser back/forward + reload simulation', () => {
    it('simulates navigate → back → forward → reload for a Windows drive remote', () => {
      configureWithOs('windows');
      // 1. Navigate to C:\Users\Foo
      const url1 = service.buildRelativeNautilusPath('C:', 'Users/Foo', 'windows');
      const loc1 = service.parseLocation(new URLSearchParams(), url1, '', 'windows');
      expect(loc1).toEqual({ remote: 'C:', path: 'Users/Foo', isStandalone: true });

      // 2. Navigate deeper to C:\Users\Foo\Bar (browser back stack grows)
      const url2 = service.buildRelativeNautilusPath('C:', 'Users/Foo/Bar', 'windows');
      const loc2 = service.parseLocation(new URLSearchParams(), url2, '', 'windows');
      expect(loc2).toEqual({ remote: 'C:', path: 'Users/Foo/Bar', isStandalone: true });

      // 3. Browser back: URL is url1 again
      const locBack = service.parseLocation(new URLSearchParams(), url1, '', 'windows');
      expect(locBack).toEqual({ remote: 'C:', path: 'Users/Foo', isStandalone: true });

      // 4. Browser forward: URL is url2 again
      const locForward = service.parseLocation(new URLSearchParams(), url2, '', 'windows');
      expect(locForward).toEqual({ remote: 'C:', path: 'Users/Foo/Bar', isStandalone: true });

      // 5. Reload: same URL parses to same location
      const locReload = service.parseLocation(new URLSearchParams(), url2, '', 'windows');
      expect(locReload).toEqual(locForward);
    });

    it('simulates navigate for a POSIX root remote', () => {
      configureWithOs('linux');
      const url = service.buildRelativeNautilusPath('/', 'home/user/docs');
      const loc = service.parseLocation(new URLSearchParams(), url, '');
      expect(loc).toEqual({ remote: '/', path: 'home/user/docs', isStandalone: true });

      // Reload: re-parse the same URL
      const locReload = service.parseLocation(new URLSearchParams(), url, '');
      expect(locReload).toEqual(loc);
    });

    it('simulates navigate for a cloud remote on a Windows engine', () => {
      configureWithOs('windows');
      const url = service.buildRelativeNautilusPath('my-s3', 'bucket/key');
      const loc = service.parseLocation(new URLSearchParams(), url, '');
      expect(loc).toEqual({ remote: 'my-s3', path: 'bucket/key', isStandalone: true });

      // Reload
      const locReload = service.parseLocation(new URLSearchParams(), url, '');
      expect(locReload).toEqual(loc);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // encodeRemote / decodeRemote
  // ───────────────────────────────────────────────────────────────────────

  describe('encodeRemote / decodeRemote', () => {
    beforeEach(() => configureWithOs('linux'));

    it('should round-trip a cloud remote name', () => {
      expect(service.encodeRemote('googledrive')).toBe('googledrive');
      expect(service.decodeRemote('googledrive')).toBe('googledrive');
    });

    it('should round-trip a Windows drive-letter remote (e.g. `C:`)', () => {
      // The colon in `C:` must be percent-encoded so it doesn't conflict
      // with the URL scheme separator.
      expect(service.encodeRemote('C:')).toBe('C%3A');
      expect(service.decodeRemote('C%3A')).toBe('C:');
    });

    it('should round-trip a POSIX root remote (`/`)', () => {
      expect(service.encodeRemote('/')).toBe('%2F');
      expect(service.decodeRemote('%2F')).toBe('/');
    });

    it('should round-trip a remote name with spaces', () => {
      expect(service.encodeRemote('Google Drive')).toBe('Google%20Drive');
      expect(service.decodeRemote('Google%20Drive')).toBe('Google Drive');
    });

    it('should round-trip a UNC-style remote (\\\\server\\share)', () => {
      expect(service.encodeRemote('\\\\server\\share')).toBe(
        encodeURIComponent('\\\\server\\share')
      );
      expect(service.decodeRemote(service.encodeRemote('\\\\server\\share'))).toBe(
        '\\\\server\\share'
      );
    });

    it('should decode a malformed remote without throwing', () => {
      expect(() => service.decodeRemote('foo%ZZ')).not.toThrow();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Special characters in paths
  // ───────────────────────────────────────────────────────────────────────

  describe('special characters in paths', () => {
    beforeEach(() => configureWithOs('linux'));

    it('should round-trip paths with spaces', () => {
      const encoded = service.encodePath('My Documents/Reports');
      expect(encoded).toBe('My%20Documents/Reports');
      expect(service.decodePath(encoded)).toBe('My Documents/Reports');
    });

    it('should round-trip paths with `#` (URL fragment delimiter)', () => {
      const encoded = service.encodePath('folder/file #1.txt');
      expect(encoded).toBe('folder/file%20%231.txt');
      expect(service.decodePath(encoded)).toBe('folder/file #1.txt');
    });

    it('should round-trip paths with `?` (URL query delimiter)', () => {
      const encoded = service.encodePath('folder/what?.txt');
      expect(encoded).toBe('folder/what%3F.txt');
      expect(service.decodePath(encoded)).toBe('folder/what?.txt');
    });

    it('should round-trip paths with `&`', () => {
      const encoded = service.encodePath('folder/tom & jerry.txt');
      expect(encoded).toBe('folder/tom%20%26%20jerry.txt');
      expect(service.decodePath(encoded)).toBe('folder/tom & jerry.txt');
    });

    it('should round-trip paths with `+`', () => {
      const encoded = service.encodePath('folder/c++ notes.txt');
      expect(encoded).toBe('folder/c%2B%2B%20notes.txt');
      expect(service.decodePath(encoded)).toBe('folder/c++ notes.txt');
    });

    it('should round-trip paths with `%` (must be encoded to avoid double-decoding)', () => {
      const encoded = service.encodePath('folder/50%off.txt');
      expect(encoded).toBe('folder/50%25off.txt');
      expect(service.decodePath(encoded)).toBe('folder/50%off.txt');
    });

    it('should round-trip paths with non-ASCII / Unicode characters', () => {
      const encoded = service.encodePath('文件夹/文件.txt');
      expect(encoded).toBe(encodeURIComponent('文件夹') + '/' + encodeURIComponent('文件.txt'));
      expect(service.decodePath(encoded)).toBe('文件夹/文件.txt');
    });

    it('should decode a malformed escape sequence without throwing', () => {
      expect(() => service.decodePath('foo%ZZbar')).not.toThrow();
      expect(service.decodePath('foo%ZZbar')).toBe('foo%ZZbar');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Normalization helpers
  // ───────────────────────────────────────────────────────────────────────

  describe('normalization helpers', () => {
    beforeEach(() => configureWithOs('linux'));

    it('toCanonicalSeparators: converts backslashes to forward slashes', () => {
      expect(service.toCanonicalSeparators('C:\\Users\\Foo')).toBe('C:/Users/Foo');
      expect(service.toCanonicalSeparators('')).toBe('');
    });

    it('toNativeDisplay: POSIX style is identity', () => {
      expect(service.toNativeDisplay('/home/user', 'posix')).toBe('/home/user');
      expect(service.toNativeDisplay('Photos/2024', 'posix')).toBe('Photos/2024');
    });

    it('toNativeDisplay: Windows style converts forward slashes to backslashes', () => {
      expect(service.toNativeDisplay('C:/Users/Foo', 'windows')).toBe('C:\\Users\\Foo');
      expect(service.toNativeDisplay('Users/Foo', 'windows')).toBe('Users\\Foo');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Mixed-remote session: same engine, different pathStyles per remote
  // ───────────────────────────────────────────────────────────────────────

  describe('mixed-remote session (pathStyle varies per remote)', () => {
    it('local Windows drive uses windows pathStyle, cloud remote uses POSIX', () => {
      configureWithOs('windows');

      // Windows local drive
      const localBuilt = service.buildRelativeNautilusPath('C:', 'Users/Foo', 'windows');
      const localParsed = service.parseLocation(new URLSearchParams(), localBuilt, '', 'windows');
      expect(localParsed).toEqual({ remote: 'C:', path: 'Users/Foo', isStandalone: true });

      // Cloud remote on the same engine — POSIX paths
      const cloudBuilt = service.buildRelativeNautilusPath('my-s3', 'bucket/key', 'posix');
      const cloudParsed = service.parseLocation(new URLSearchParams(), cloudBuilt, '');
      expect(cloudParsed).toEqual({ remote: 'my-s3', path: 'bucket/key', isStandalone: true });
    });

    it('local POSIX root uses posix pathStyle, SFTP uses POSIX', () => {
      configureWithOs('linux');

      const localBuilt = service.buildRelativeNautilusPath('/', 'home/user/docs', 'posix');
      const localParsed = service.parseLocation(new URLSearchParams(), localBuilt, '');
      expect(localParsed).toEqual({ remote: '/', path: 'home/user/docs', isStandalone: true });

      const sftpBuilt = service.buildRelativeNautilusPath('my-sftp', 'etc/passwd', 'posix');
      const sftpParsed = service.parseLocation(new URLSearchParams(), sftpBuilt, '');
      expect(sftpParsed).toEqual({ remote: 'my-sftp', path: 'etc/passwd', isStandalone: true });
    });

    it('parseLocation with wrong pathStyle recovers correctly when re-parsed', () => {
      configureWithOs('linux');
      // If we parse a Windows drive URL without pathStyle='windows', the
      // drive-letter recovery won't fire — the segment is treated as a
      // remote name. This is correct behavior: the caller must supply
      // pathStyle from the remote's metadata.
      const url = '/nautilus/C%3A/Users/Foo';
      const posixResult = service.parseLocation(new URLSearchParams(), url, '');
      expect(posixResult.remote).toBe('C:'); // C: is just a remote name here
      expect(posixResult.path).toBe('Users/Foo');

      // With pathStyle='windows', same URL still parses identically because
      // C: is its own segment (not fused with backslash)
      const winResult = service.parseLocation(new URLSearchParams(), url, '', 'windows');
      expect(winResult.remote).toBe('C:');
      expect(winResult.path).toBe('Users/Foo');
    });

    it('Windows drive with backslash in URL segment requires windows pathStyle', () => {
      configureWithOs('linux');
      // Legacy URL: entire `C:\Users\Foo` encoded as one segment
      const url = '/nautilus/C%3A%5CUsers%5CFoo';

      // Without windows pathStyle: treated as a single remote name
      const posixResult = service.parseLocation(new URLSearchParams(), url, '');
      expect(posixResult.remote).toBe('C:\\Users\\Foo');
      expect(posixResult.path).toBeNull();

      // With windows pathStyle: drive-letter recovery fires
      const winResult = service.parseLocation(new URLSearchParams(), url, '', 'windows');
      expect(winResult.remote).toBe('C:');
      expect(winResult.path).toBe('Users/Foo');
    });
  });
});
