import { describe, expect, it } from 'vitest';
import { buildNautilusPath, parseNautilusPath } from './nautilus-url.utils';

describe('Nautilus URLs', () => {
  it.each([
    ['drive', 'folder/file.txt'],
    ['C:', 'Users/My Documents/file.txt'],
    ['/', 'home/user/file.txt'],
    ['Google Drive', '文件夹/file #1? & 50%.txt'],
    ['sftp', 'folder/a\\b.txt'],
    ['s3', 'bucket/a//b/'],
    ['drive', '/leading/slash'],
    ['drive', '%2F'],
    ['drive', ''],
  ])('round-trips remote %s and path %s without normalization', (remote, path) => {
    const pathname = buildNautilusPath(remote, path);
    expect(parseNautilusPath(new URL(pathname, 'https://localhost').pathname)).toEqual({
      remote,
      path,
    });
  });

  it('uses a single root URL for an absent remote', () => {
    expect(buildNautilusPath(null)).toBe('/nautilus');
    expect(buildNautilusPath('', 'ignored')).toBe('/nautilus');
    expect(parseNautilusPath('/nautilus')).toEqual({ remote: null, path: '' });
    expect(parseNautilusPath('/nautilus/')).toEqual({ remote: null, path: '' });
  });

  it.each([
    '',
    '/',
    '/nautilus-backup/drive',
    '/other/nautilus/drive',
    '/nautilus//folder',
    '#/nautilus/drive',
    '/?browse=drive',
  ])('rejects non-route input %s', pathname => {
    expect(parseNautilusPath(pathname)).toBeNull();
  });

  it.each(['/nautilus/%ZZ/file', '/nautilus/drive/%E0%A4%A'])(
    'rejects malformed escaping in %s',
    pathname => {
      expect(parseNautilusPath(pathname)).toBeNull();
    }
  );

  it('does not reinterpret an encoded remote as a legacy absolute path', () => {
    expect(parseNautilusPath('/nautilus/C%3A%5CUsers%5CFoo')).toEqual({
      remote: 'C:\\Users\\Foo',
      path: '',
    });
  });
});
