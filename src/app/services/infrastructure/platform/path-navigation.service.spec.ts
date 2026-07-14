/**
 * Unit tests for PathNavigationService — specifically the canonical
 * encode/decode utility that is the single source of truth for how
 * filesystem paths are serialized into URLs.
 *
 * Covers the regression cases called out in the bug report:
 *   - Windows drive-letter paths (`C:\Users\Name\Folder`)
 *   - UNC paths (`\\server\share`)
 *   - POSIX paths (`/home/user/folder`)
 *   - Paths containing special/reserved URL characters
 *     (spaces, `#`, `?`, `&`, `+`, `%`)
 *
 * Also covers the higher-level URL build/parse round-trip and the
 * `parseLocation` URL → (remote, path) parser.
 */
import { TestBed } from '@angular/core/testing';
import { Location, LocationStrategy, PathLocationStrategy } from '@angular/common';
import { PathNavigationService } from './path-navigation.service';

describe('PathNavigationService', () => {
  let service: PathNavigationService;

  beforeEach(() => {
    // `Location` and `PathLocationStrategy` are both `providedIn: 'root'`,
    // but we list them explicitly here so the test is self-contained and
    // doesn't depend on Router being configured (the production app does
    // NOT use Router — see path-navigation.service.ts for the rationale).
    TestBed.configureTestingModule({
      providers: [Location, { provide: LocationStrategy, useClass: PathLocationStrategy }],
    });
    service = TestBed.inject(PathNavigationService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  // ── encodePath / decodePath round-trip ────────────────────────────────────

  describe('encodePath / decodePath round-trip', () => {
    // Helper: assert that encode → decode returns the canonical form.
    const assertRoundTrip = (input: string, expectedCanonical?: string): void => {
      const encoded = service.encodePath(input);
      const decoded = service.decodePath(encoded);
      expect(decoded).toBe(expectedCanonical ?? input.replace(/\\/g, '/'));
    };

    it('should round-trip a Windows drive-letter path with backslashes', () => {
      // Bug 2 regression: backslashes must be normalized to forward slashes
      // so the path survives the URL round-trip.
      assertRoundTrip('C:\\Users\\Name\\Folder');
      // Verify the encoded form does NOT contain raw backslashes.
      expect(service.encodePath('C:\\Users\\Name\\Folder')).not.toContain('\\');
    });

    it('should round-trip a Windows drive-letter path with forward slashes', () => {
      assertRoundTrip('C:/Users/Name/Folder');
    });

    it('should round-trip a UNC path (\\\\server\\share\\folder)', () => {
      // UNC paths use leading double-backslash.  Our encoder normalizes
      // backslashes to forward slashes, then splits on `/` (filtering
      // empty segments).  The leading `//` collapses to a single `/`
      // in the canonical form — this is a known limitation, but the
      // round-trip is still consistent (encode → decode → encode →
      // decode is idempotent).
      const input = '\\\\server\\share\\folder';
      const encoded = service.encodePath(input);
      const decoded = service.decodePath(encoded);
      // Re-encoding the decoded value should produce the same encoded
      // form (idempotency).
      expect(service.encodePath(decoded)).toBe(encoded);
      // The decoded form is consistent (forward slashes, single leading
      // slash).
      expect(decoded).toBe('/server/share/folder');
      expect(encoded).toBe('/server/share/folder');
    });

    it('should round-trip a POSIX absolute path', () => {
      assertRoundTrip('/home/user/folder');
      // POSIX absolute paths must keep their leading slash.
      expect(service.encodePath('/home/user/folder').startsWith('/')).toBeTrue();
    });

    it('should round-trip a POSIX relative path', () => {
      assertRoundTrip('relative/path/to/folder');
    });

    it('should round-trip a single-segment path', () => {
      assertRoundTrip('folder');
    });

    it('should round-trip an empty path', () => {
      expect(service.encodePath('')).toBe('');
      expect(service.decodePath('')).toBe('');
    });

    // ── Special/reserved URL characters ──────────────────────────────────────

    it('should round-trip paths with spaces', () => {
      assertRoundTrip('C:\\Users\\My Documents\\Reports');
      // Verify the encoded form percent-encodes the space.
      expect(service.encodePath('My Documents')).toBe('My%20Documents');
    });

    it('should round-trip paths with `#` (URL fragment delimiter)', () => {
      // Bug 2 regression: raw `#` in a path would be interpreted as the
      // start of the URL fragment, truncating the path.
      assertRoundTrip('folder/file #1.txt');
      expect(service.encodePath('file #1.txt')).toBe('file%20%231.txt');
    });

    it('should round-trip paths with `?` (URL query delimiter)', () => {
      assertRoundTrip('folder/what?.txt');
      expect(service.encodePath('what?.txt')).toBe('what%3F.txt');
    });

    it('should round-trip paths with `&`', () => {
      assertRoundTrip('folder/tom & jerry.txt');
      expect(service.encodePath('tom & jerry.txt')).toBe('tom%20%26%20jerry.txt');
    });

    it('should round-trip paths with `+`', () => {
      // Note: `+` is NOT a reserved char in path segments per RFC 3986,
      // but `encodeURIComponent` encodes it to `%2B` for safety.  Our
      // decoder must handle both forms.
      assertRoundTrip('folder/c++ notes.txt');
      expect(service.encodePath('c++ notes.txt')).toBe('c%2B%2B%20notes.txt');
    });

    it('should round-trip paths with `%` (must be encoded to avoid double-decoding)', () => {
      // Bug 2 regression: a raw `%` in a path that is NOT an escape
      // sequence would be misinterpreted by decodeURIComponent.
      // Our encoder must encode `%` as `%25`.
      assertRoundTrip('folder/50%off.txt');
      expect(service.encodePath('50%off.txt')).toBe('50%25off.txt');
    });

    it('should round-trip paths with non-ASCII / Unicode characters', () => {
      assertRoundTrip('文件夹/文件.txt');
      expect(service.encodePath('文件夹')).toBe(encodeURIComponent('文件夹'));
    });

    it('should round-trip paths with mixed special characters', () => {
      assertRoundTrip('C:\\Users\\Me\\My Docs #1\\what? & why% +1.txt');
    });

    it('should preserve a leading slash for POSIX-absolute paths', () => {
      expect(service.encodePath('/a/b/c')).toBe('/a/b/c');
    });

    it('should NOT add a leading slash for relative paths', () => {
      expect(service.encodePath('a/b/c')).toBe('a/b/c');
    });

    it('should normalize backslashes to forward slashes in the encoded output', () => {
      expect(service.encodePath('a\\b\\c')).toBe('a/b/c');
    });

    it('should decode a malformed escape sequence without throwing', () => {
      // Defensive: a corrupted URL with a stray `%` should not crash.
      expect(() => service.decodePath('foo%ZZbar')).not.toThrow();
      // The malformed segment is returned raw.
      expect(service.decodePath('foo%ZZbar')).toBe('foo%ZZbar');
    });
  });

  // ── encodeRemote / decodeRemote ───────────────────────────────────────────

  describe('encodeRemote / decodeRemote', () => {
    it('should round-trip a cloud remote name', () => {
      expect(service.encodeRemote('googledrive')).toBe('googledrive');
      expect(service.decodeRemote('googledrive')).toBe('googledrive');
    });

    it('should round-trip a Windows drive-letter remote (e.g. `C:`)', () => {
      // Bug 2 regression: the colon in `C:` must be percent-encoded so
      // it doesn't conflict with the URL scheme separator.
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

  // ── buildNautilusUrl / buildRelativeNautilusPath ──────────────────────────

  describe('buildNautilusUrl / buildRelativeNautilusPath', () => {
    it('should build a fully-qualified URL with origin', () => {
      const url = service.buildNautilusUrl('C:', 'Users/Foo');
      expect(url).toBe(`${window.location.origin}/nautilus/C%3A/Users/Foo`);
    });

    it('should build a relative path without origin', () => {
      const url = service.buildRelativeNautilusPath('C:', 'Users/Foo');
      expect(url).toBe('/nautilus/C%3A/Users/Foo');
    });

    it('should build a nautilus-root URL when no remote is provided', () => {
      expect(service.buildRelativeNautilusPath(null, null)).toBe('/nautilus');
      expect(service.buildNautilusUrl(null, null)).toBe(`${window.location.origin}/nautilus`);
    });

    it('should build a remote-only URL when no path is provided', () => {
      expect(service.buildRelativeNautilusPath('googledrive', null)).toBe('/nautilus/googledrive');
    });

    it('should encode Windows backslashes in the path', () => {
      // Path passed with Windows separators must not leak backslashes
      // into the URL.
      const url = service.buildRelativeNautilusPath('C:', 'Users\\Foo');
      expect(url).toBe('/nautilus/C%3A/Users/Foo');
      expect(url).not.toContain('\\');
    });

    it('should encode special characters in the path', () => {
      const url = service.buildRelativeNautilusPath('C:', 'My Docs/file #1.txt');
      expect(url).toBe('/nautilus/C%3A/My%20Docs/file%20%231.txt');
    });
  });

  // ── parseLocation ─────────────────────────────────────────────────────────

  describe('parseLocation', () => {
    it('should parse a standalone pathname (Windows drive)', () => {
      const loc = service.parseLocation(new URLSearchParams(), '/nautilus/C%3A/Users/Foo', '');
      expect(loc).toEqual({
        remote: 'C:',
        path: 'Users/Foo',
        isStandalone: true,
      });
    });

    it('should parse a standalone pathname (POSIX root)', () => {
      const loc = service.parseLocation(new URLSearchParams(), '/nautilus/%2F/home/user', '');
      expect(loc).toEqual({
        remote: '/',
        path: 'home/user',
        isStandalone: true,
      });
    });

    it('should parse a standalone pathname (cloud remote)', () => {
      const loc = service.parseLocation(
        new URLSearchParams(),
        '/nautilus/googledrive/Photos/2024',
        ''
      );
      expect(loc).toEqual({
        remote: 'googledrive',
        path: 'Photos/2024',
        isStandalone: true,
      });
    });

    it('should parse a standalone pathname with no path (remote root)', () => {
      const loc = service.parseLocation(new URLSearchParams(), '/nautilus/googledrive', '');
      expect(loc).toEqual({
        remote: 'googledrive',
        path: null,
        isStandalone: true,
      });
    });

    it('should parse a hash-based standalone URL', () => {
      const loc = service.parseLocation(
        new URLSearchParams(),
        '/some/other/path',
        '#/nautilus/C%3A/Users/Foo'
      );
      expect(loc).toEqual({
        remote: 'C:',
        path: 'Users/Foo',
        isStandalone: true,
      });
    });

    it('should parse a query-param-style browse URL (non-standalone)', () => {
      const loc = service.parseLocation(new URLSearchParams('browse=C%3A&path=Users/Foo'), '/', '');
      expect(loc).toEqual({
        remote: 'C:',
        path: 'Users/Foo',
        isStandalone: false,
      });
    });

    it('should return null remote/path when no nautilus marker is present', () => {
      const loc = service.parseLocation(new URLSearchParams(), '/', '');
      expect(loc).toEqual({
        remote: null,
        path: null,
        isStandalone: false,
      });
    });

    it('should decode special characters in the parsed path', () => {
      const loc = service.parseLocation(
        new URLSearchParams(),
        '/nautilus/C%3A/My%20Docs/file%20%231.txt',
        ''
      );
      expect(loc.remote).toBe('C:');
      expect(loc.path).toBe('My Docs/file #1.txt');
    });

    it('should preserve a POSIX-absolute leading slash in the path', () => {
      const loc = service.parseLocation(new URLSearchParams(), '/nautilus/%2F/home/user', '');
      expect(loc.path).toBe('home/user');
    });

    it('should defensively re-parse a single-segment URL-encoded drive path', () => {
      // Legacy / malformed URL: the entire location was encoded as a
      // single segment.  parseLocation should still recover the
      // remote + path.
      const loc = service.parseLocation(new URLSearchParams(), '/nautilus/C%3A%5CUsers%5CFoo', '');
      expect(loc.remote).toBe('C:');
      // The path comes back with forward-slash separators (canonical form).
      expect(loc.path).toBe('Users/Foo');
    });

    it('should defensively re-parse a single-segment URL-encoded POSIX absolute path', () => {
      const loc = service.parseLocation(new URLSearchParams(), '/nautilus/%2Fhome%2Fuser', '');
      expect(loc.remote).toBe('/');
      expect(loc.path).toBe('home/user');
    });
  });

  // ── Full round-trip: build URL → parse URL ────────────────────────────────

  describe('full round-trip (build → parse)', () => {
    const cases: { name: string; remote: string; path: string }[] = [
      { name: 'Windows drive path', remote: 'C:', path: 'Users/Name/Folder' },
      { name: 'Windows drive path with backslashes', remote: 'C:', path: 'Users\\Name\\Folder' },
      { name: 'POSIX root path', remote: '/', path: 'home/user/folder' },
      { name: 'cloud remote path', remote: 'googledrive', path: 'Photos/2024/album' },
      { name: 'path with spaces', remote: 'C:', path: 'My Documents/Reports' },
      { name: 'path with #, ?, &', remote: 'C:', path: 'folder/file #1.txt? & more' },
      { name: 'path with %', remote: 'C:', path: 'folder/50%off.txt' },
      { name: 'path with Unicode', remote: 'C:', path: '文件夹/文件.txt' },
    ];

    for (const c of cases) {
      it(`should round-trip ${c.name}`, () => {
        const built = service.buildRelativeNautilusPath(c.remote, c.path);
        // Strip the leading '/nautilus/' to feed just the remote/path part
        // back through parseLocation.
        const parsed = service.parseLocation(new URLSearchParams(), built, '');
        expect(parsed.remote).toBe(c.remote);
        // Path comes back in canonical (forward-slash) form.
        expect(parsed.path).toBe(c.path.replace(/\\/g, '/'));
      });
    }
  });

  // ── Normalization helpers ─────────────────────────────────────────────────

  describe('normalization helpers', () => {
    it('toCanonicalSeparators: should convert backslashes to forward slashes', () => {
      expect(service.toCanonicalSeparators('C:\\Users\\Foo')).toBe('C:/Users/Foo');
      expect(service.toCanonicalSeparators('')).toBe('');
    });

    it('toNativeDisplay: should convert to backslashes for Windows drive roots', () => {
      expect(service.toNativeDisplay('C:/Users/Foo', 'C:\\')).toBe('C:\\Users\\Foo');
      expect(service.toNativeDisplay('C:/Users/Foo', 'C:')).toBe('C:\\Users\\Foo');
    });

    it('toNativeDisplay: should leave forward slashes for non-Windows roots', () => {
      expect(service.toNativeDisplay('/home/user', '/')).toBe('/home/user');
      expect(service.toNativeDisplay('Photos/2024', 'googledrive')).toBe('Photos/2024');
    });
  });
});
