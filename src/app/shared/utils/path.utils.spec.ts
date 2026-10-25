import * as pathUtils from './path.utils';
import {
  normalizePath,
  normalizeForPlatform,
  joinPath,
  getFilename,
  getDirname,
  getParentPath,
  getPathSegments,
  normalizeRemoteName,
  normalizeRemoteForRclone,
  splitLocalPath,
  splitLocalForStat,
  normalizeFs,
  buildPathString,
  buildPathStrings,
  parsePathType,
  getRemoteNameFromValue,
  getFullDisplayPath,
  getDisplaySegment,
  extractName,
  isLocalPath,
  isTrulyLocalPath,
  splitFsPath,
  parseLocation,
  splitSegments,
  checkMountPathCollision,
} from './path.utils';
import { ExplorerRoot, PathGroup } from '@app/types';

describe('path.utils', () => {
  describe('normalizePath', () => {
    it('handles empty and null strings', () => {
      expect(normalizePath('')).toBe('');
    });

    it('collapses backslashes to forward slashes', () => {
      expect(normalizePath('a\\b\\c')).toBe('a/b/c');
    });

    it('resolves . and .. segments', () => {
      expect(normalizePath('/a/b/./c/../d')).toBe('/a/b/d');
      expect(normalizePath('a/b/../../c')).toBe('c');
    });

    it('preserves leading slash for absolute paths', () => {
      expect(normalizePath('/root/path')).toBe('/root/path');
      expect(normalizePath('relative/path')).toBe('relative/path');
    });
  });

  describe('normalizeForPlatform', () => {
    it('returns empty string for empty input', () => {
      expect(normalizeForPlatform('')).toBe('');
    });

    it('formats for windows', () => {
      expect(normalizeForPlatform('C:/folder/sub', 'windows')).toBe('C:\\folder\\sub');
    });

    it('formats for posix', () => {
      expect(normalizeForPlatform('folder\\sub\\file.txt', 'posix')).toBe('folder/sub/file.txt');
    });
  });

  describe('joinPath', () => {
    it('joins segments into canonical posix path', () => {
      expect(joinPath('root', 'sub', 'file.txt')).toBe('root/sub/file.txt');
      expect(joinPath('/base', 'sub/')).toBe('/base/sub');
    });

    it('ignores empty segments without turning relative paths into absolute paths', () => {
      expect(joinPath('', 'C:/Users/hakan')).toBe('C:/Users/hakan');
      expect(joinPath('', 'Photos', '', 'Arşiv 2026')).toBe('Photos/Arşiv 2026');
      expect(joinPath('', '/home/hakan', '')).toBe('/home/hakan');
      expect(joinPath('', '')).toBe('');
      expect(joinPath()).toBe('');
      expect(joinPath(null as unknown as string, undefined as unknown as string, 'docs')).toBe(
        'docs'
      );
    });
  });

  describe('getFilename & getDirname', () => {
    it('extracts filename and dirname', () => {
      expect(getFilename('/home/user/doc.pdf')).toBe('doc.pdf');
      expect(getDirname('/home/user/doc.pdf')).toBe('/home/user');
      expect(getDirname('/root')).toBe('/');
      expect(getDirname('relative')).toBe('');
      expect(getFilename('')).toBe('');
    });
  });

  describe('getParentPath', () => {
    it('returns parent path or empty string', () => {
      expect(getParentPath('/a/b/c')).toBe('/a/b');
      expect(getParentPath('/a')).toBe('/');
      expect(getParentPath('/')).toBe('');
      expect(getParentPath('C:\\', 'windows')).toBe('');
    });

    it('preserves the separator when navigating to a Windows drive root', () => {
      expect(getParentPath('C:/Users', 'windows')).toBe('C:/');
      expect(getParentPath('d:\\Arşiv 2026', 'windows')).toBe('d:/');
      expect(getParentPath('C:/Users', 'posix')).toBe('C:');
    });

    it('preserves the Windows network share and stops at its root', () => {
      expect(getParentPath('\\\\server\\share\\folder', 'windows')).toBe('//server/share');
      expect(getParentPath('//server/share/', 'windows')).toBe('');
      expect(getParentPath('\\\\server\\share', 'windows')).toBe('');
    });

    it('keeps namespace and current-drive roots when navigating upwards on Windows', () => {
      expect(getParentPath('\\\\?\\UNC\\server\\share\\folder', 'windows')).toBe(
        '//?/UNC/server/share'
      );
      expect(getParentPath('//?/unc/server/share', 'windows')).toBe('');
      expect(getParentPath('\\\\?\\C:\\folder', 'windows')).toBe('//?/C:/');
      expect(getParentPath('//?/C:/', 'windows')).toBe('');
      expect(getParentPath('\\Users\\hakan', 'windows')).toBe('/Users');
      expect(getParentPath('\\Users', 'windows')).toBe('/');
      expect(getParentPath('\\', 'windows')).toBe('');
    });

    it('preserves literal backslashes in POSIX filenames', () => {
      expect(getParentPath('photos/a\\b.txt', 'posix')).toBe('photos');
      expect(getParentPath('photos/a\\b/file.txt', 'posix')).toBe('photos/a\\b');
      expect(getParentPath('a\\b.txt', 'posix')).toBe('');
    });
  });

  describe('getPathSegments & splitSegments', () => {
    it('splits into segments and progressive paths', () => {
      expect(splitSegments('a/b/c')).toEqual(['a', 'b', 'c']);
      expect(splitSegments('')).toEqual([]);
      const segs = getPathSegments('a/b/c');
      expect(segs).toEqual([
        { name: 'a', path: 'a' },
        { name: 'b', path: 'a/b' },
        { name: 'c', path: 'a/b/c' },
      ]);
    });
  });

  describe('normalizeRemoteName & normalizeRemoteForRclone', () => {
    it('cleans remote names', () => {
      expect(normalizeRemoteName('gdrive:')).toBe('gdrive');
      expect(normalizeRemoteName('s3{uuid}:')).toBe('s3');
      expect(normalizeRemoteName('C:', 'windows')).toBe('C:');
      expect(normalizeRemoteName('')).toBe('');
    });

    it('adds colon for rclone remote format unless absolute local', () => {
      expect(normalizeRemoteForRclone('myremote')).toBe('myremote:');
      expect(normalizeRemoteForRclone('myremote:')).toBe('myremote:');
      expect(normalizeRemoteForRclone('/local/path')).toBe('/local/path');
      expect(normalizeRemoteForRclone('C:\\local', 'windows')).toBe('C:\\local');
    });

    it('keeps Windows UNC, rooted and drive-relative filesystem names intact', () => {
      for (const path of [
        '\\\\server\\share',
        '//server/share',
        '\\Windows',
        '/Windows',
        'D:folder',
      ]) {
        expect(normalizeRemoteForRclone(path, 'windows')).toBe(path);
      }
      expect(normalizeRemoteForRclone('drive', 'windows')).toBe('drive:');
    });
  });

  describe('splitLocalPath & splitLocalForStat', () => {
    it('splits Windows UNC and namespace paths without inventing a C: drive', () => {
      const cases: [string, string, string][] = [
        ['\\\\server\\share\\Arşiv\\file.txt', '//server/share', 'Arşiv/file.txt'],
        ['//server/share/', '//server/share', ''],
        ['\\\\server\\share', '//server/share', ''],
        ['\\\\?\\UNC\\server\\share\\file.txt', '//?/UNC/server/share', 'file.txt'],
        ['\\\\?\\C:\\Users\\hakan', '//?/C:/', 'Users/hakan'],
        ['\\\\server', '//server', ''],
      ];
      for (const [path, root, relative] of cases) {
        expect(splitLocalForStat(path, 'windows')).toEqual({ root, relative });
      }
    });

    it('preserves drive-relative and root-relative Windows path semantics', () => {
      expect(splitLocalForStat('D:folder\\file.txt', 'windows')).toEqual({
        root: 'D:',
        relative: 'folder/file.txt',
      });
      expect(splitLocalForStat('\\Users\\hakan', 'windows')).toEqual({
        root: '/',
        relative: 'Users/hakan',
      });
      for (const style of ['windows', 'posix'] as const) {
        expect(splitLocalForStat('relative/file.txt', style)).toEqual({
          root: '.',
          relative: 'relative/file.txt',
        });
        expect(splitLocalForStat('', style)).toEqual({ root: '.', relative: '' });
      }
    });
    it('splits windows paths', () => {
      const res = splitLocalPath('C:\\Users\\test', 'windows');
      expect(res.remote).toBe('C:\\');
      expect(res.remainder).toBe('Users\\test');
      expect(splitLocalPath('C:', 'windows')).toEqual({ remote: 'C:\\', remainder: '' });
      expect(splitLocalPath('D:folder\\child', 'windows')).toEqual({
        remote: 'D:',
        remainder: 'folder\\child',
      });

      const stat = splitLocalForStat('D:/data/file.txt', 'windows');
      expect(stat.root).toBe('D:/');
      expect(stat.relative).toBe('data/file.txt');
    });

    it('splits posix paths', () => {
      const res = splitLocalPath('/var/log/app.log', 'posix');
      expect(res.remote).toBe('/');
      expect(res.remainder).toBe('var/log/app.log');

      const stat = splitLocalForStat('/var/log/app.log', 'posix');
      expect(stat.root).toBe('/');
      expect(stat.relative).toBe('var/log/app.log');
    });
  });

  describe('normalizeFs', () => {
    it('handles strings and rclone Fs objects', () => {
      expect(normalizeFs('myremote:bucket')).toBe('myremote:bucket');
      expect(normalizeFs({ _name: 'gdrive', _root: 'docs' })).toBe('gdrive:docs');
      expect(normalizeFs({ type: 'drive', _root: 'my-drive' })).toBe(':drive:my-drive');
      expect(normalizeFs(null)).toBe('');
    });
  });

  describe('buildPathString & buildPathStrings', () => {
    it('builds path strings from PathGroup objects', () => {
      const localGroup: PathGroup = { type: 'local', path: '/local/dir', remote: '' };
      const currentGroup: PathGroup = { type: 'currentRemote', path: 'folder', remote: '' };
      const otherGroup: PathGroup = {
        type: 'otherRemote:backup',
        path: 'archive',
        remote: 'backup',
      };

      expect(buildPathString(localGroup, 'main')).toBe('/local/dir');
      expect(buildPathString(currentGroup, 'main')).toBe('main:folder');
      expect(buildPathString(otherGroup, 'main')).toBe('backup:archive');
      expect(buildPathStrings([localGroup, currentGroup], 'main')).toEqual([
        '/local/dir',
        'main:folder',
      ]);
    });
  });

  describe('parsePathType & getRemoteNameFromValue', () => {
    it('parses type and extracts remote name', () => {
      expect(parsePathType('local')).toBe('local');
      expect(parsePathType('currentRemote')).toBe('currentRemote');
      expect(parsePathType('otherRemote:b2')).toBe('otherRemote');

      expect(getRemoteNameFromValue('currentRemote', 'myremote')).toBe('myremote');
      expect(getRemoteNameFromValue('otherRemote:box', 'myremote')).toBe('box');
      expect(getRemoteNameFromValue('local', 'myremote')).toBeNull();
    });
  });

  describe('getFullDisplayPath & getDisplaySegment & extractName', () => {
    it('formats display paths correctly', () => {
      const localRoot: ExplorerRoot = {
        name: '/home',
        label: 'Home',
        isLocal: true,
        type: 'local',
      };
      const cloudRoot: ExplorerRoot = {
        name: 'drive',
        label: 'Google Drive',
        isLocal: false,
        type: 'cloud',
      };

      expect(getFullDisplayPath(localRoot, 'user/docs', 'posix')).toBe('/home/user/docs');
      expect(getFullDisplayPath(cloudRoot, 'work/sheet.csv')).toBe('drive:work/sheet.csv');
      expect(getDisplaySegment(cloudRoot, 'work/sheet.csv')).toBe('sheet.csv');
      expect(getDisplaySegment(cloudRoot, '')).toBe('Google Drive');
      expect(extractName('folder/file.txt')).toBe('file.txt');
      expect(extractName('', 'remoteName')).toBe('remoteName');
    });
  });

  describe('isLocalPath & isTrulyLocalPath & splitFsPath', () => {
    const remoteNames = new Set(['gdrive', 's3', 'onedrive']);

    it('identifies local and remote paths', () => {
      expect(isLocalPath('/home/user', remoteNames)).toBe(true);
      expect(isLocalPath('gdrive:bucket/file', remoteNames)).toBe(false);
      expect(isLocalPath('unknown_local:file', remoteNames)).toBe(true);

      expect(isTrulyLocalPath('/var/log', remoteNames)).toBe(true);
      expect(isTrulyLocalPath('C:\\data', remoteNames, 'windows')).toBe(true);
      expect(isTrulyLocalPath('s3:bucket', remoteNames)).toBe(false);
      expect(isTrulyLocalPath('/home/hakan/Arşiv:2026', remoteNames)).toBe(true);
      expect(isTrulyLocalPath('\\\\server\\share', remoteNames, 'windows')).toBe(true);

      expect(splitFsPath('/home/test', remoteNames)).toEqual({ remote: '', path: '/home/test' });
      expect(splitFsPath('s3:bucket/data', remoteNames)).toEqual({
        remote: 's3',
        path: 'bucket/data',
      });
    });
  });

  describe('parseLocation', () => {
    const knownRemotes: ExplorerRoot[] = [
      { name: '/', label: 'Root', isLocal: true, type: 'local' },
      { name: 'C:/', label: 'C Drive', isLocal: true, type: 'local' },
      { name: 'gdrive', label: 'GDrive', isLocal: false, type: 'cloud' },
    ];

    it('parses cloud location', () => {
      const res = parseLocation('gdrive:docs/report.pdf', knownRemotes);
      expect(res).not.toBeNull();
      expect(res?.remote.name).toBe('gdrive');
      expect(res?.path).toBe('docs/report.pdf');
    });

    it('parses posix local location', () => {
      const res = parseLocation('/etc/config', knownRemotes);
      expect(res).not.toBeNull();
      expect(res?.remote.name).toBe('/');
      expect(res?.path).toBe('etc/config');
    });

    it('parses windows drive location', () => {
      const res = parseLocation('C:/Users/Admin', knownRemotes);
      expect(res).not.toBeNull();
      expect(res?.remote.name).toBe('C:/');
      expect(res?.path).toBe('Users/Admin');
    });

    const windowsRoots: ExplorerRoot[] = [
      { name: 'C:\\Users\\hakan', label: 'Home', isLocal: true, type: 'local' },
      { name: 'C:\\', label: 'C:', isLocal: true, type: 'local' },
      { name: 'C:\\Users\\hakan\\Downloads', label: 'Downloads', isLocal: true, type: 'local' },
    ];

    it('matches local folder boundaries instead of partial names', () => {
      expect(parseLocation('C:\\Users\\hakan-old\\file.txt', windowsRoots, 'windows')).toEqual({
        remote: windowsRoots[1],
        path: 'Users/hakan-old/file.txt',
      });
      expect(
        parseLocation('C:/Users/hakan/Downloads-old/file.txt', windowsRoots, 'windows')
      ).toEqual({
        remote: windowsRoots[0],
        path: 'Downloads-old/file.txt',
      });
    });

    it('chooses the most specific local root regardless of drive list order', () => {
      for (const roots of [windowsRoots, [...windowsRoots].reverse()]) {
        expect(
          parseLocation('c:/users/HAKAN/downloads/Arşiv 2026/旅行.txt', roots, 'windows')
        ).toEqual({
          remote: windowsRoots[2],
          path: 'Arşiv 2026/旅行.txt',
        });
      }
    });

    it('preserves path boundaries for Unicode root names whose lowercase length changes', () => {
      const root: ExplorerRoot = {
        name: 'C:\\Users\\İİsmail',
        label: 'Home',
        isLocal: true,
        type: 'local',
      };
      expect(
        parseLocation('C:\\Users\\İİsmail\\Arşiv.txt', [root, ...windowsRoots], 'windows')
      ).toEqual({
        remote: root,
        path: 'Arşiv.txt',
      });
    });

    it('handles drive and directory roots with or without a trailing separator', () => {
      for (const path of ['C:', 'C:/', 'C:\\']) {
        expect(parseLocation(path, windowsRoots, 'windows')).toEqual({
          remote: windowsRoots[1],
          path: '',
        });
      }
      for (const path of ['C:/Users/hakan/Downloads', 'C:\\Users\\hakan\\Downloads\\']) {
        expect(parseLocation(path, windowsRoots, 'windows')).toEqual({
          remote: windowsRoots[2],
          path: '',
        });
      }
    });

    it('prefers mounted POSIX roots and preserves colons within local filenames', () => {
      const mount: ExplorerRoot = {
        name: '/mnt/archive',
        label: 'Archive',
        isLocal: true,
        type: 'local',
      };
      expect(parseLocation('/mnt/archive/:report.txt', [...knownRemotes, mount])).toEqual({
        remote: mount,
        path: ':report.txt',
      });
      expect(parseLocation('/mnt/archive-old/report.txt', [...knownRemotes, mount])).toEqual({
        remote: knownRemotes[0],
        path: 'mnt/archive-old/report.txt',
      });
    });

    it('keeps POSIX root matching case sensitive and preserves literal backslashes', () => {
      const mount: ExplorerRoot = {
        name: '/mnt/Archive',
        label: 'Archive',
        isLocal: true,
        type: 'local',
      };
      const roots = [knownRemotes[0], mount];
      expect(parseLocation('/mnt/archive/file.txt', roots)).toEqual({
        remote: knownRemotes[0],
        path: 'mnt/archive/file.txt',
      });
      expect(parseLocation('/mnt/Archive/a\\b.txt', roots)).toEqual({
        remote: mount,
        path: 'a\\b.txt',
      });
    });

    it('keeps cloud filenames unchanged when the engine is Windows', () => {
      expect(parseLocation('gdrive:photos/a\\b.txt', knownRemotes, 'windows')).toEqual({
        remote: knownRemotes[2],
        path: 'photos/a\\b.txt',
      });
    });

    it('resolves local paths outside the enumerated drives without inventing cloud remotes', () => {
      for (const [input, root, path] of [
        ['\\\\server\\share\\docs', '//server/share', 'docs'],
        ['E:\\folder', 'E:/', 'folder'],
        ['D:folder\\file.txt', 'D:.', 'folder/file.txt'],
        ['\\Users\\hakan', '/', 'Users/hakan'],
      ]) {
        expect(parseLocation(input, windowsRoots, 'windows')).toEqual({
          remote: { name: root, label: root, type: 'local', isLocal: true },
          path,
        });
      }
      expect(parseLocation('/archive/notes:2026', [])).toEqual({
        remote: { name: '/', label: '/', type: 'local', isLocal: true },
        path: 'archive/notes:2026',
      });
    });
  });

  describe('checkMountPathCollision', () => {
    const isLocalMock = (p: string): boolean => !p.startsWith('remote:');
    const mockSettings = {
      remote1: {
        mount: {
          default: {
            mountPoint: '/mnt/media',
          },
        },
        bisync: {
          sync1: {
            path1: '/home/user/documents',
            path2: 'remote:backup',
          },
        },
      },
      remote2: {
        mount: {
          custom: {
            dest: { path: '/mnt/photos' },
          },
        },
      },
    };

    it('checks current mount and bisync profile schemas as well as legacy records', () => {
      const settings = {
        drive: {
          mountConfigs: { mount: { rclone: { mountPoint: '/mnt/archive' } } },
          bisyncConfigs: {
            sync: { rclone: { path1: '/home/user/sync', path2: 'remote:backup' } },
          },
        },
      };
      expect(checkMountPathCollision('/mnt/archive', 'other', settings, isLocalMock)).toEqual([
        { remoteName: 'drive', profileName: 'mount', opType: 'mount', path: '/mnt/archive' },
      ]);
      expect(checkMountPathCollision('/home/user/sync', 'other', settings, isLocalMock)).toEqual([
        { remoteName: 'drive', profileName: 'sync', opType: 'bisync', path: '/home/user/sync' },
      ]);
      expect(
        checkMountPathCollision('/mnt/archive', 'drive', settings, isLocalMock, 'mount')
      ).toEqual([]);
    });

    it('compares Windows paths across native and canonical separator forms', () => {
      const settings = {
        drive: { mountConfigs: { mount: { rclone: { mountPoint: 'C:\\Mount\\Arşiv' } } } },
      };
      expect(
        checkMountPathCollision('c:/mount/Arşiv/', 'other', settings, isLocalMock, undefined, {
          pathStyle: 'windows',
        }).length
      ).toBe(1);
    });

    it('keeps POSIX mount paths case sensitive', () => {
      const settings = {
        drive: { mountConfigs: { mount: { rclone: { mountPoint: '/mnt/Archive' } } } },
      };
      expect(checkMountPathCollision('/mnt/archive', 'other', settings, isLocalMock)).toEqual([]);
      expect(checkMountPathCollision('/mnt/Archive/', 'other', settings, isLocalMock).length).toBe(
        1
      );
    });

    it('excludes only the edited operation when another operation has the same profile name', () => {
      const settings = {
        drive: {
          mountConfigs: { Shared: { rclone: { mountPoint: '/shared' } } },
          bisyncConfigs: { Shared: { rclone: { path1: '/shared' } } },
        },
      };
      expect(
        checkMountPathCollision('/shared', 'drive', settings, isLocalMock, 'Shared', {
          currentOperation: 'mount',
        })
      ).toEqual([
        { remoteName: 'drive', profileName: 'Shared', opType: 'bisync', path: '/shared' },
      ]);
    });

    it('returns empty array when proposed path is empty', () => {
      expect(checkMountPathCollision('', 'remote1', mockSettings, isLocalMock)).toEqual([]);
      expect(checkMountPathCollision('   ', 'remote1', mockSettings, isLocalMock)).toEqual([]);
    });

    it('returns empty array when no collision exists', () => {
      const res = checkMountPathCollision('/mnt/other', 'remote1', mockSettings, isLocalMock);
      expect(res).toEqual([]);
    });

    it('detects collision with mountPoint from another remote', () => {
      const res = checkMountPathCollision('/mnt/media', 'remote2', mockSettings, isLocalMock);
      expect(res.length).toBe(1);
      expect(res[0]).toEqual({
        remoteName: 'remote1',
        profileName: 'default',
        opType: 'mount',
        path: '/mnt/media',
      });
    });

    it('detects collision with bisync path1 from another remote', () => {
      const res = checkMountPathCollision(
        '/home/user/documents/',
        'remote2',
        mockSettings,
        isLocalMock
      );
      expect(res.length).toBe(1);
      expect(res[0].remoteName).toBe('remote1');
      expect(res[0].opType).toBe('bisync');
    });

    it('ignores collision with same remote and profile', () => {
      const res = checkMountPathCollision(
        '/mnt/media',
        'remote1',
        mockSettings,
        isLocalMock,
        'default'
      );
      expect(res).toEqual([]);
    });
  });
});

describe('normalizePath (canonical POSIX form)', () => {
  it('should resolve . and .. segments', () => {
    expect(pathUtils.normalizePath('/a/b/./c/../d')).toBe('/a/b/d');
  });

  it('should collapse backslashes to forward slashes (canonical form is always POSIX)', () => {
    expect(pathUtils.normalizePath('a\\b\\c')).toBe('a/b/c');
  });

  it('should NOT strip leading slash before a drive letter (POSIX has no drive letters)', () => {
    // Old behavior sniffed drive letters and stripped the leading slash.
    // Under the engine-driven model, drive-letter handling is the job of
    // the Windows-native renderer (`normalizeForPlatform(path, 'windows')`),
    // not the canonical normalizer.
    expect(pathUtils.normalizePath('/C:/Users/hakan')).toBe('/C:/Users/hakan');
  });
});
describe('multi-path display helpers', () => {
  it('should detect multi-path values', () => {
    expect(pathUtils.isMultiPath('a')).toBe(false);
    expect(pathUtils.isMultiPath([])).toBe(false);
    expect(pathUtils.isMultiPath(['a'])).toBe(false);
    expect(pathUtils.isMultiPath(['a', 'b'])).toBe(true);
  });

  it('should normalize path values into arrays', () => {
    expect(pathUtils.asPathArray('a')).toEqual(['a']);
    expect(pathUtils.asPathArray('')).toEqual(['']);
    expect(pathUtils.asPathArray(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('should return the primary path', () => {
    expect(pathUtils.getPrimaryPath('a')).toBe('a');
    expect(pathUtils.getPrimaryPath([])).toBe('');
    expect(pathUtils.getPrimaryPath(['a', 'b'])).toBe('a');
  });

  it('should format compact display text', () => {
    expect(pathUtils.formatPathDisplay('a')).toBe('a');
    expect(pathUtils.formatPathDisplay([])).toBe('');
    expect(pathUtils.formatPathDisplay(['a'])).toBe('a');
    expect(pathUtils.formatPathDisplay(['a', 'b', 'c'])).toBe('a, b, c');
  });

  it('should format tooltip text', () => {
    expect(pathUtils.formatPathTooltip('a')).toBe('a');
    expect(pathUtils.formatPathTooltip(['a', 'b'])).toBe('a\nb');
  });
});
describe('parsePathType', () => {
  it('should parse local', () => {
    expect(pathUtils.parsePathType('local')).toBe('local');
  });

  it('should parse currentRemote', () => {
    expect(pathUtils.parsePathType('currentRemote')).toBe('currentRemote');
  });

  it('should parse otherRemote', () => {
    expect(pathUtils.parsePathType('otherRemote:myremote')).toBe('otherRemote');
  });
});
