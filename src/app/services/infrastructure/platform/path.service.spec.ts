import { TestBed } from '@angular/core/testing';
import { PathService } from './path.service';
import { FileBrowserItem, ExplorerRoot } from '@app/types';
import { BackendService } from '../system/backend.service';
import { signal, computed } from '@angular/core';

/**
 * Mock BackendService with a writable `isWindows` signal so each test can
 * flip the engine-reported OS without reconfiguring the TestBed.
 */
function mockBackend(initialOs: 'linux' | 'windows' | 'darwin' = 'linux'): {
  backend: Record<string, unknown>;
  setOs: (os: string) => void;
} {
  const backends = signal([
    { name: 'Local', isLocal: true, os: initialOs } as {
      name: string;
      isLocal: boolean;
      os: string;
    },
  ]);
  const activeBackend = signal('Local');
  const isWindows = signal(initialOs === 'windows');
  return {
    backend: {
      backends,
      activeBackend,
      isWindows,
    },
    setOs: (os: string): void => {
      backends.set([{ name: 'Local', isLocal: true, os }]);
      isWindows.set(os.includes('windows'));
    },
  };
}

describe('PathService', () => {
  let service: PathService;
  let setEngineOs: (os: string) => void;

  beforeEach(() => {
    const mock = mockBackend('linux');
    setEngineOs = mock.setOs;
    TestBed.configureTestingModule({
      providers: [PathService, { provide: BackendService, useValue: mock.backend }],
    });
    service = TestBed.inject(PathService);
  });
  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('uses the backend path style when detecting mount collisions', () => {
    setEngineOs('windows');
    const settings = {
      drive: { mountConfigs: { mount: { rclone: { mountPoint: 'D:\\Mount\\Arşiv' } } } },
    };
    expect(service.checkMountPathCollision('d:/mount/Arşiv', 'other', settings).length).toBe(1);
    setEngineOs('linux');
    expect(service.checkMountPathCollision('d:/mount/Arşiv', 'other', settings)).toEqual([]);
  });

  it('updates path classification reactively without invalidating unchanged name sets', () => {
    let reads = 0;
    const local = computed(() => {
      reads++;
      return service.isLocalPath('drive:photos');
    });
    expect(local()).toBe(true);
    service.setRemoteNames(['drive', 's3']);
    expect(local()).toBe(false);
    const afterChange = reads;
    service.setRemoteNames(['s3', 'drive']);
    expect(local()).toBe(false);
    expect(reads).toBe(afterChange);
    service.setRemoteNames([]);
    expect(local()).toBe(true);
  });

  it('parses paths of the remote being created before it exists in the backend list', () => {
    for (const path of ['', 'photos', 'folder with spaces/file:1']) {
      expect(service.parseFsString(`new-drive:${path}`, 'local', 'new-drive')).toEqual({
        type: 'currentRemote',
        path,
        remote: '',
      });
    }
    expect(service.parseFsString('/tmp/new-drive:photos', 'local', 'new-drive')).toEqual({
      type: 'local',
      path: '/tmp/new-drive:photos',
      remote: '',
    });
  });

  it('keeps Windows drive paths local when a new remote name matches the drive letter', () => {
    setEngineOs('windows');
    expect(service.parseFsString('C:\\files', 'local', 'C')).toEqual({
      type: 'local',
      path: 'C:\\files',
      remote: '',
    });
  });

  // ── Engine-reported OS → PathStyle derivation ──────────────────────────────

  describe('enginePathStyle / pathStyleForRemote', () => {
    it('enginePathStyle derives from BackendInfo.os (rclone core/version)', () => {
      setEngineOs('linux');
      expect(service.enginePathStyle()).toBe('posix');
      setEngineOs('windows');
      expect(service.enginePathStyle()).toBe('windows');
      setEngineOs('darwin');
      expect(service.enginePathStyle()).toBe('posix');
    });

    it('local remote follows engine OS', () => {
      setEngineOs('windows');
      expect(service.pathStyleForRemote({ isLocal: true })).toBe('windows');
      setEngineOs('linux');
      expect(service.pathStyleForRemote({ isLocal: true })).toBe('posix');
    });

    it('SFTP / cloud remotes are POSIX regardless of engine OS (sourced from operations/fsinfo IsLocal=false)', () => {
      setEngineOs('windows');
      expect(service.pathStyleForRemote({ isLocal: false })).toBe('posix');
      setEngineOs('linux');
      expect(service.pathStyleForRemote({ isLocal: false })).toBe('posix');
    });

    it('null/undefined remote falls back to engine OS', () => {
      setEngineOs('windows');
      expect(service.pathStyleForRemote(null)).toBe('windows');
      expect(service.pathStyleForRemote(undefined)).toBe('windows');
    });
  });

  // ── Native display rendering (pathStyle parameterized) ────────────────────

  describe('normalizeForPlatform (native display)', () => {
    it('POSIX style: backslashes → forward slashes, collapse repeated slashes', () => {
      expect(service.normalizeForPlatform('a\\b\\c', 'posix')).toBe('a/b/c');
      expect(service.normalizeForPlatform('a//b', 'posix')).toBe('a/b');
    });

    it('Windows style: forward slashes → backslashes', () => {
      expect(service.normalizeForPlatform('C:/Users/Foo', 'windows')).toBe('C:\\Users\\Foo');
      expect(service.normalizeForPlatform('a/b/c', 'windows')).toBe('a\\b\\c');
    });

    it('defaults to engine OS when no pathStyle is provided', () => {
      setEngineOs('windows');
      expect(service.normalizeForPlatform('a/b')).toBe('a\\b');
      setEngineOs('linux');
      expect(service.normalizeForPlatform('a\\b')).toBe('a/b');
    });
  });

  // ── Remote name normalization (pathStyle parameterized) ───────────────────

  describe('normalizeRemoteName (pathStyle parameterized)', () => {
    it('Windows: preserves single-letter drive roots (C:, D:)', () => {
      expect(service.normalizeRemoteName('C:', 'windows')).toBe('C:');
      expect(service.normalizeRemoteName('D:', 'windows')).toBe('D:');
      expect(service.normalizeRemoteName('z:', 'windows')).toBe('z:');
    });

    it('POSIX: strips trailing colon even for single-letter names (no drive-letter concept)', () => {
      // On a POSIX engine, `C:` is just a remote named `C` — the colon is
      // rclone remote-syntax, not a drive-letter marker.
      expect(service.normalizeRemoteName('C:', 'posix')).toBe('C');
      expect(service.normalizeRemoteName('s3:', 'posix')).toBe('s3');
    });

    it('strips trailing colon for standard remotes in both styles', () => {
      expect(service.normalizeRemoteName('googledrive:', 'posix')).toBe('googledrive');
      expect(service.normalizeRemoteName('googledrive:', 'windows')).toBe('googledrive');
    });

    it('strips profile suffix {profile-name}', () => {
      expect(service.normalizeRemoteName('myremote{custom}', 'posix')).toBe('myremote');
    });

    it('returns empty string for null/undefined', () => {
      expect(service.normalizeRemoteName(undefined)).toBe('');
      expect(service.normalizeRemoteName('')).toBe('');
    });
  });

  describe('normalizeRemoteForRclone (pathStyle parameterized)', () => {
    it('appends colon to standard remote names', () => {
      expect(service.normalizeRemoteForRclone('googledrive', 'posix')).toBe('googledrive:');
      expect(service.normalizeRemoteForRclone('googledrive:', 'posix')).toBe('googledrive:');
    });

    it('POSIX: treats leading-slash paths as absolute local (no colon appended)', () => {
      expect(service.normalizeRemoteForRclone('/home/user', 'posix')).toBe('/home/user');
    });

    it('Windows: treats drive-letter paths as absolute local (no colon appended)', () => {
      expect(service.normalizeRemoteForRclone('C:\\', 'windows')).toBe('C:\\');
      expect(service.normalizeRemoteForRclone('D:/data', 'windows')).toBe('D:/data');
    });

    it('POSIX: would append colon to `C:` because POSIX has no drive letters', () => {
      // On a POSIX engine, `C:` is a remote named `C` — append nothing because
      // it already ends with `:`. The point is: drive-letter detection is
      // gated on pathStyle, not sniffed from the string.
      expect(service.normalizeRemoteForRclone('C:', 'posix')).toBe('C:');
    });
  });

  // ── Parent / dirname / filename ───────────────────────────────────────────

  describe('getParentPath (pathStyle parameterized)', () => {
    it('POSIX: returns parent of a path', () => {
      expect(service.getParentPath('/a/b/c', 'posix')).toBe('/a/b');
      expect(service.getParentPath('/a', 'posix')).toBe('/');
      expect(service.getParentPath('/', 'posix')).toBe('');
    });

    it('Windows: returns empty for drive root (C:, C:\\, C:/)', () => {
      expect(service.getParentPath('C:', 'windows')).toBe('');
      expect(service.getParentPath('C:\\', 'windows')).toBe('');
      expect(service.getParentPath('C:/', 'windows')).toBe('');
    });

    it('Windows: returns drive root as parent of top-level path', () => {
      // Input here is in canonical POSIX form (forward slashes) — the
      // drive-letter check still recognizes `C:` as a root prefix.
      expect(service.getParentPath('C:/Users', 'windows')).toBe('C:/');
    });
  });

  // ── Local path splitting (pathStyle parameterized) ────────────────────────

  describe('splitLocalPath (pathStyle parameterized)', () => {
    it('POSIX: splits POSIX-absolute path into root + remainder', () => {
      expect(service.splitLocalPath('/home/user/docs', 'posix')).toEqual({
        remote: '/',
        remainder: 'home/user/docs',
      });
    });

    it('Windows: splits drive-letter path into drive + remainder', () => {
      expect(service.splitLocalPath('C:\\Users\\Foo', 'windows')).toEqual({
        remote: 'C:\\',
        remainder: 'Users\\Foo',
      });
      expect(service.splitLocalPath('D:/data/files', 'windows')).toEqual({
        remote: 'D:/',
        remainder: 'data/files',
      });
    });

    it('Windows: returns drive root only when no remainder', () => {
      expect(service.splitLocalPath('C:\\', 'windows')).toEqual({
        remote: 'C:\\',
        remainder: '',
      });
    });
  });

  describe('splitLocalForStat (pathStyle parameterized)', () => {
    it('POSIX: root=/, relative=path-without-leading-slash', () => {
      expect(service.splitLocalForStat('/home/user/file', 'posix')).toEqual({
        root: '/',
        relative: 'home/user/file',
      });
    });

    it('Windows: extracts drive as root, normalizes backslashes in relative', () => {
      expect(service.splitLocalForStat('C:\\Users\\Foo', 'windows')).toEqual({
        root: 'C:/',
        relative: 'Users/Foo',
      });
    });

    it('Windows: resolves relative paths from the daemon working directory', () => {
      expect(service.splitLocalForStat('relative/path', 'windows')).toEqual({
        root: '.',
        relative: 'relative/path',
      });
    });
  });

  // ── Full display path (derives pathStyle from remote) ─────────────────────

  describe('getFullDisplayPath (derives pathStyle from ExplorerRoot.isLocal)', () => {
    const localWindowsDrive: ExplorerRoot = {
      name: 'C:',
      label: 'C:',
      type: 'hard-drive',
      isLocal: true,
    };
    const localPosixRoot: ExplorerRoot = {
      name: '/',
      label: '/',
      type: 'hard-drive',
      isLocal: true,
    };
    const sftpRemote: ExplorerRoot = {
      name: 'my-sftp',
      label: 'my-sftp',
      type: 'sftp',
      isLocal: false,
    };
    const s3Remote: ExplorerRoot = { name: 'my-s3', label: 'my-s3', type: 's3', isLocal: false };

    it('Windows local drive: renders backslashes when engine is Windows', () => {
      setEngineOs('windows');
      // Path is in canonical POSIX form; output should be Windows native.
      expect(service.getFullDisplayPath(localWindowsDrive, 'Users/Foo')).toBe('C:\\Users\\Foo');
    });

    it('Windows local drive: renders forward slashes when engine is POSIX (cross-OS browse)', () => {
      // Browsing a Windows drive through a Linux rclone engine isn't typical,
      // but if it happens the path-style follows the engine OS — POSIX.
      setEngineOs('linux');
      expect(service.getFullDisplayPath(localWindowsDrive, 'Users/Foo')).toBe('C:/Users/Foo');
    });

    it('POSIX local root: always forward slashes', () => {
      setEngineOs('linux');
      expect(service.getFullDisplayPath(localPosixRoot, 'home/user')).toBe('/home/user');
      // Engine on Windows but remote is POSIX root: the path segments get
      // backslash-rendered (path-style follows engine OS for local remotes),
      // but the root name '/' is preserved verbatim — it's the engine-reported
      // POSIX root identifier, not a path-style-affected separator.
      setEngineOs('windows');
      expect(service.getFullDisplayPath(localPosixRoot, 'home/user')).toBe('/home\\user');
    });

    it('SFTP remote: POSIX-style regardless of engine OS', () => {
      setEngineOs('windows');
      expect(service.getFullDisplayPath(sftpRemote, 'etc/passwd')).toBe('my-sftp:etc/passwd');
      setEngineOs('linux');
      expect(service.getFullDisplayPath(sftpRemote, 'etc/passwd')).toBe('my-sftp:etc/passwd');
    });

    it('S3 remote: POSIX-style regardless of engine OS', () => {
      setEngineOs('windows');
      expect(service.getFullDisplayPath(s3Remote, 'bucket/key')).toBe('my-s3:bucket/key');
      setEngineOs('linux');
      expect(service.getFullDisplayPath(s3Remote, 'bucket/key')).toBe('my-s3:bucket/key');
    });

    it('explicit pathStyle override only affects LOCAL remotes (cloud remotes always POSIX)', () => {
      setEngineOs('linux');
      // Cloud/SFTP remotes use POSIX paths internally regardless of display
      // pathStyle — the `pathStyle` parameter only governs local-remote
      // separator rendering. Passing 'windows' for a cloud remote is a no-op.
      expect(service.getFullDisplayPath(sftpRemote, 'etc/passwd', 'windows')).toBe(
        'my-sftp:etc/passwd'
      );

      // For a LOCAL remote, the explicit pathStyle does take effect:
      expect(service.getFullDisplayPath(localWindowsDrive, 'Users/Foo', 'windows')).toBe(
        'C:\\Users\\Foo'
      );
    });
  });

  describe('resolvePathGroup', () => {
    it('preserves POSIX folder and file names containing backslashes', () => {
      const item: FileBrowserItem = {
        entry: { Path: 'a\\b/file.txt' } as FileBrowserItem['entry'],
        meta: { remote: '/archive\\', isLocal: true },
      };
      expect(service.resolvePathGroup(item, 'myremote')).toEqual({
        type: 'local',
        path: '/archive\\/a\\b/file.txt',
        remote: '',
      });
    });
    it('preserves the UNC prefix when a Windows network folder is selected', () => {
      setEngineOs('windows');
      const item: FileBrowserItem = {
        entry: { Path: 'Arşiv 2026/file.txt' } as FileBrowserItem['entry'],
        meta: { remote: '\\\\server\\share', isLocal: true },
      };
      expect(service.resolvePathGroup(item, 'myremote')).toEqual({
        type: 'local',
        path: '\\\\server\\share\\Arşiv 2026\\file.txt',
        remote: '',
      });
    });
    it('preserves a selected Windows drive root with no relative path', () => {
      setEngineOs('windows');
      for (const root of ['C:/', 'D:\\']) {
        const item: FileBrowserItem = {
          entry: { Path: '' } as FileBrowserItem['entry'],
          meta: { remote: root, isLocal: true },
        };
        expect(service.resolvePathGroup(item, 'myremote')).toEqual({
          type: 'local',
          path: root.replace(/\//g, '\\'),
          remote: '',
        });
      }
    });

    it('resolves a selected Windows folder without a leading slash', () => {
      setEngineOs('windows');
      const item: FileBrowserItem = {
        entry: { Path: 'Users/hakan/Arşiv 2026' } as FileBrowserItem['entry'],
        meta: { remote: 'C:\\', isLocal: true },
      };
      expect(service.resolvePathGroup(item, 'myremote')).toEqual({
        type: 'local',
        path: 'C:\\Users\\hakan\\Arşiv 2026',
        remote: '',
      });
    });

    it('should resolve local items correctly by joining root and path', () => {
      const item: FileBrowserItem = {
        entry: { Path: 'Documents/test' } as unknown as FileBrowserItem['entry'],
        meta: { remote: '/home/hakan', isLocal: true },
      };
      const result = service.resolvePathGroup(item, 'myremote');
      expect(result).toEqual({
        type: 'local',
        path: '/home/hakan/Documents/test',
        remote: '',
      });
    });

    it('should resolve current remote items correctly', () => {
      const item: FileBrowserItem = {
        entry: { Path: 'Photos/album' } as unknown as FileBrowserItem['entry'],
        meta: { remote: 'myremote:', isLocal: false },
      };
      const result = service.resolvePathGroup(item, 'myremote');
      expect(result).toEqual({
        type: 'currentRemote',
        path: 'Photos/album',
        remote: 'myremote',
      });
    });

    it('should resolve other remote items correctly', () => {
      const item: FileBrowserItem = {
        entry: { Path: 'Photos/album' } as unknown as FileBrowserItem['entry'],
        meta: { remote: 'gdrive:', isLocal: false },
      };
      const result = service.resolvePathGroup(item, 'myremote');
      expect(result).toEqual({
        type: 'otherRemote:gdrive',
        path: 'Photos/album',
        remote: 'gdrive',
      });
    });
  });

  // ── isLocalPath (registry-based; unchanged) ───────────────────────────────

  describe('isLocalPath', () => {
    beforeEach(() => {
      service.setRemoteNames(['remote', 'my-remote', 's3', 'folder', 'Google Drive']);
    });

    it('should correctly classify local paths', () => {
      expect(service.isLocalPath('/absolute/path/on/linux')).toBe(true);
      expect(service.isLocalPath('relative/path/on/linux')).toBe(true);
      expect(service.isLocalPath('C:\\absolute\\path\\on\\windows')).toBe(true);
      expect(service.isLocalPath('d:\\some\\path')).toBe(true);
      expect(service.isLocalPath('c:relative/path')).toBe(true);
      expect(service.isLocalPath('\\relative\\backslash\\path')).toBe(true);
      expect(service.isLocalPath('/path/with:colon/in/middle')).toBe(true);
      expect(service.isLocalPath('')).toBe(false);
    });

    it('should correctly classify remote paths', () => {
      expect(service.isLocalPath('remote:')).toBe(false);
      expect(service.isLocalPath('my-remote:bucket/file.txt')).toBe(false);
      expect(service.isLocalPath('s3:path')).toBe(false);
      expect(service.isLocalPath('folder:name/file.txt')).toBe(false);
    });

    it('should correctly classify bare remote names', () => {
      expect(service.isLocalPath('Google Drive')).toBe(false);
      expect(service.isLocalPath('remote')).toBe(false);
      expect(service.isLocalPath('s3')).toBe(false);
    });
  });

  // ── isTrulyLocalPath (pathStyle parameterized — no string-only sniffing) ──

  describe('isTrulyLocalPath (pathStyle parameterized)', () => {
    beforeEach(() => {
      service.setRemoteNames(['remote', 'my-remote']);
    });

    it('Windows pathStyle: recognizes drive-letter paths as truly local', () => {
      expect(service.isTrulyLocalPath('C:\\Users\\Foo', 'windows')).toBe(true);
      expect(service.isTrulyLocalPath('D:\\data\\file.txt', 'windows')).toBe(true);
      expect(service.isTrulyLocalPath('c:relative', 'windows')).toBe(true);
    });

    it('Windows pathStyle: rejects non-drive-letter colon paths as remote', () => {
      expect(service.isTrulyLocalPath('remote:path', 'windows')).toBe(false);
      expect(service.isTrulyLocalPath('my-remote:bucket/file', 'windows')).toBe(false);
    });

    it('POSIX pathStyle: single-letter colon prefix is NOT treated as drive letter', () => {
      // On a POSIX engine, `C:something` is a remote named `C`, not a drive.
      // The old string-sniffing code would incorrectly classify this as local.
      expect(service.isTrulyLocalPath('C:something', 'posix')).toBe(false);
      expect(service.isTrulyLocalPath('s:path', 'posix')).toBe(false);
    });

    it('POSIX pathStyle: no-colon local paths are still truly local', () => {
      expect(service.isTrulyLocalPath('/home/user/docs', 'posix')).toBe(true);
      expect(service.isTrulyLocalPath('relative/path', 'posix')).toBe(true);
    });

    it('defaults to engine OS (pathStyle parameter)', () => {
      setEngineOs('linux');
      expect(service.isTrulyLocalPath('C:something')).toBe(false);
      setEngineOs('windows');
      expect(service.isTrulyLocalPath('C:\\Users')).toBe(true);
    });

    it('empty/null paths return false', () => {
      expect(service.isTrulyLocalPath('', 'windows')).toBe(false);
      expect(service.isTrulyLocalPath('', 'posix')).toBe(false);
    });
  });

  // ── parseFsString (unchanged logic; uses isLocalPath registry) ────────────

  describe('parseFsString', () => {
    beforeEach(() => {
      service.setRemoteNames(['remote', 'my-remote']);
    });

    it('should parse Windows local paths correctly', () => {
      const result1 = service.parseFsString('C:\\', 'currentRemote', 'my-remote');
      expect(result1).toEqual({ type: 'local', path: 'C:\\', remote: '' });

      const result2 = service.parseFsString('d:\\some\\path', 'currentRemote', 'my-remote');
      expect(result2).toEqual({ type: 'local', path: 'd:\\some\\path', remote: '' });
    });

    it('should parse standard remote paths correctly', () => {
      const result = service.parseFsString('remote:bucket/path', 'currentRemote', 'my-remote');
      expect(result).toEqual({ type: 'otherRemote:remote', path: 'bucket/path', remote: 'remote' });
    });
  });
});
