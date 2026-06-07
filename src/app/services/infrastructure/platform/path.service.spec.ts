import { TestBed } from '@angular/core/testing';
import { PathService } from './path.service';
import { FileBrowserItem } from '@app/types';

describe('PathService', () => {
  let service: PathService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(PathService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('normalizePath', () => {
    it('should resolve . and .. segments', () => {
      expect(service.normalizePath('/a/b/./c/../d')).toBe('/a/b/d');
    });

    it('should replace backslashes', () => {
      expect(service.normalizePath('a\\b\\c')).toBe('a/b/c');
    });
  });

  describe('normalizeRemoteName', () => {
    it('should preserve colon for local Windows drive letters', () => {
      expect(service.normalizeRemoteName('C:', true)).toBe('C:');
      expect(service.normalizeRemoteName('D:', true)).toBe('D:');
      expect(service.normalizeRemoteName('z:', true)).toBe('z:');
    });

    it('should strip colon for remotes even if they look like drive letters', () => {
      expect(service.normalizeRemoteName('C:', false)).toBe('C');
      expect(service.normalizeRemoteName('D:', false)).toBe('D');
    });

    it('should strip colon for standard remotes', () => {
      expect(service.normalizeRemoteName('googledrive:', false)).toBe('googledrive');
      expect(service.normalizeRemoteName('my-remote:', false)).toBe('my-remote');
    });

    it('should return empty string for null/undefined', () => {
      expect(service.normalizeRemoteName(undefined, false)).toBe('');
      expect(service.normalizeRemoteName('', false)).toBe('');
    });

    it('should return name as-is if no colon is present', () => {
      expect(service.normalizeRemoteName('myremote', false)).toBe('myremote');
      expect(service.normalizeRemoteName('C', true)).toBe('C');
    });
  });

  describe('normalizeRemoteForRclone', () => {
    it('should add colon to standard remotes', () => {
      expect(service.normalizeRemoteForRclone('googledrive')).toBe('googledrive:');
    });

    it('should not add second colon', () => {
      expect(service.normalizeRemoteForRclone('googledrive:')).toBe('googledrive:');
    });

    it('should handle local paths with leading slash', () => {
      expect(service.normalizeRemoteForRclone('/home/user')).toBe('/home/user');
    });

    it('should handle Windows local paths', () => {
      expect(service.normalizeRemoteForRclone('C:\\')).toBe('C:\\');
    });
  });

  describe('getParentPath', () => {
    it('should return parent of a path', () => {
      expect(service.getParentPath('/a/b/c')).toBe('/a/b');
    });

    it('should handle root', () => {
      expect(service.getParentPath('/')).toBe('');
    });

    it('should preserve leading slash', () => {
      expect(service.getParentPath('/a')).toBe('/');
    });
  });

  describe('multi-path display helpers', () => {
    it('should detect multi-path values', () => {
      expect(service.isMultiPath('a')).toBeFalse();
      expect(service.isMultiPath([])).toBeFalse();
      expect(service.isMultiPath(['a'])).toBeFalse();
      expect(service.isMultiPath(['a', 'b'])).toBeTrue();
    });

    it('should normalize path values into arrays', () => {
      expect(service.asPathArray('a')).toEqual(['a']);
      expect(service.asPathArray('')).toEqual(['']);
      expect(service.asPathArray(['a', 'b'])).toEqual(['a', 'b']);
    });

    it('should return the primary path', () => {
      expect(service.getPrimaryPath('a')).toBe('a');
      expect(service.getPrimaryPath([])).toBe('');
      expect(service.getPrimaryPath(['a', 'b'])).toBe('a');
    });

    it('should format compact display text', () => {
      expect(service.formatPathDisplay('a')).toBe('a');
      expect(service.formatPathDisplay([])).toBe('');
      expect(service.formatPathDisplay(['a'])).toBe('a');
      expect(service.formatPathDisplay(['a', 'b', 'c'])).toBe('a, b, c');
    });

    it('should format tooltip text', () => {
      expect(service.formatPathTooltip('a')).toBe('a');
      expect(service.formatPathTooltip(['a', 'b'])).toBe('a\nb');
    });
  });

  describe('parsePathType', () => {
    it('should parse local', () => {
      expect(service.parsePathType('local')).toBe('local');
    });

    it('should parse currentRemote', () => {
      expect(service.parsePathType('currentRemote')).toBe('currentRemote');
    });

    it('should parse otherRemote', () => {
      expect(service.parsePathType('otherRemote:myremote')).toBe('otherRemote');
    });
  });

  describe('resolvePathGroup', () => {
    it('should resolve local items correctly by joining root and path', () => {
      const item: FileBrowserItem = {
        entry: { Path: 'Documents/test' } as any,
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
        entry: { Path: 'Photos/album' } as any,
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
        entry: { Path: 'Photos/album' } as any,
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

  describe('isLocalPath', () => {
    it('should correctly classify local paths', () => {
      expect(service.isLocalPath('/absolute/path/on/linux')).toBeTrue();
      expect(service.isLocalPath('relative/path/on/linux')).toBeTrue();
      expect(service.isLocalPath('C:\\absolute\\path\\on\\windows')).toBeTrue();
      expect(service.isLocalPath('d:\\some\\path')).toBeTrue();
      expect(service.isLocalPath('c:relative/path')).toBeTrue();
      expect(service.isLocalPath('\\relative\\backslash\\path')).toBeTrue();
      expect(service.isLocalPath('/path/with:colon/in/middle')).toBeTrue();
      expect(service.isLocalPath('')).toBeFalse();
    });

    it('should correctly classify remote paths', () => {
      expect(service.isLocalPath('remote:')).toBeFalse();
      expect(service.isLocalPath('my-remote:bucket/file.txt')).toBeFalse();
      expect(service.isLocalPath('s3:path')).toBeFalse();
      expect(service.isLocalPath('folder:name/file.txt')).toBeFalse();
    });
  });
});
