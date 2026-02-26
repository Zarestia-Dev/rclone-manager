import { TestBed } from '@angular/core/testing';

import { PathSelectionService } from './path-selection.service';

describe('PathSelectionService', () => {
  let service: PathSelectionService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(PathSelectionService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
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
});
