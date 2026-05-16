import { TestBed } from '@angular/core/testing';
import { PathService } from './path.service';

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
      expect(service.formatPathDisplay(['a', 'b', 'c'])).toBe('a (+2)');
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
});
