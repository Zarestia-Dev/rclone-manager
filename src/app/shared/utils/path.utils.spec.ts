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
  });

  describe('splitLocalPath & splitLocalForStat', () => {
    it('splits windows paths', () => {
      const res = splitLocalPath('C:\\Users\\test', 'windows');
      expect(res.remote).toBe('C:\\');
      expect(res.remainder).toBe('Users\\test');

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
  });
});
