import { parseUrlInfo, extractFilenameFromUrl, buildDestinationPreview } from './url.utils';

describe('url.utils', () => {
  describe('parseUrlInfo', () => {
    it('should return invalid for empty or null strings', () => {
      expect(parseUrlInfo(null).isValid).toBe(false);
      expect(parseUrlInfo(undefined).isValid).toBe(false);
      expect(parseUrlInfo('').isValid).toBe(false);
      expect(parseUrlInfo('   ').isValid).toBe(false);
    });

    it('should parse standard HTTPS file URLs correctly', () => {
      const info = parseUrlInfo('https://releases.ubuntu.com/24.04/ubuntu-24.04-desktop-amd64.iso');
      expect(info.isValid).toBe(true);
      expect(info.hostname).toBe('releases.ubuntu.com');
      expect(info.protocol).toBe('https:');
      expect(info.isHttps).toBe(true);
      expect(info.inferredFilename).toBe('ubuntu-24.04-desktop-amd64.iso');
      expect(info.extension).toBe('iso');
    });

    it('should handle URL query parameters, hash fragments, and encoded spaces', () => {
      const info = parseUrlInfo(
        'https://cdn.example.com/downloads/my%20archive%20v1.2.tar.gz?token=abc12345&expire=99999#download'
      );
      expect(info.isValid).toBe(true);
      expect(info.hostname).toBe('cdn.example.com');
      expect(info.inferredFilename).toBe('my archive v1.2.tar.gz');
      expect(info.extension).toBe('gz');
    });

    it('should reject invalid plain strings without domain or protocol', () => {
      expect(parseUrlInfo('viewer-btn').isValid).toBe(false);
      expect(parseUrlInfo('hello world').isValid).toBe(false);
      expect(parseUrlInfo('some_random_filename').isValid).toBe(false);
    });

    it('should parse FTP, SFTP, and WebDAV protocols correctly', () => {
      const ftp = parseUrlInfo('ftp://ftp.example.com/files/archive.zip');
      expect(ftp.isValid).toBe(true);
      expect(ftp.protocolLabel).toBe('FTP');
      expect(ftp.protocolIcon).toBe('ftp');
      expect(ftp.inferredFilename).toBe('archive.zip');

      const sftp = parseUrlInfo('sftp://backup.server.net:2222/daily.tar.gz');
      expect(sftp.isValid).toBe(true);
      expect(sftp.protocolLabel).toBe('SFTP');
      expect(sftp.protocolIcon).toBe('sftp');
      expect(sftp.inferredFilename).toBe('daily.tar.gz');

      const webdav = parseUrlInfo('webdav://cloud.example.org/remote.php/webdav/doc.pdf');
      expect(webdav.isValid).toBe(true);
      expect(webdav.protocolLabel).toBe('WebDAV');
      expect(webdav.protocolIcon).toBe('webdav');
      expect(webdav.inferredFilename).toBe('doc.pdf');
    });

    it('should handle IP addresses and localhost correctly', () => {
      const ip = parseUrlInfo('http://192.168.1.100:8080/stream.mp4');
      expect(ip.isValid).toBe(true);
      expect(ip.protocolLabel).toBe('HTTP');
      expect(ip.inferredFilename).toBe('stream.mp4');

      const local = parseUrlInfo('http://localhost:3000/test.json');
      expect(local.isValid).toBe(true);
      expect(local.inferredFilename).toBe('test.json');
    });

    it('should handle URL with bare domain and path', () => {
      const info = parseUrlInfo('images.unsplash.com/photo-1234.jpg');
      expect(info.isValid).toBe(true);
      expect(info.hostname).toBe('images.unsplash.com');
      expect(info.inferredFilename).toBe('photo-1234.jpg');
      expect(info.extension).toBe('jpg');
    });

    it('should handle URLs with no path segment', () => {
      const info = parseUrlInfo('https://example.com/');
      expect(info.isValid).toBe(true);
      expect(info.hostname).toBe('example.com');
      expect(info.inferredFilename).toBe('');
      expect(info.extension).toBe('');
    });
  });

  describe('extractFilenameFromUrl', () => {
    it('should extract filename accurately', () => {
      expect(extractFilenameFromUrl('https://example.com/test-file.png')).toBe('test-file.png');
      expect(extractFilenameFromUrl('https://example.com/dir/file.mp4?v=1')).toBe('file.mp4');
      expect(extractFilenameFromUrl('invalid-url')).toBe('');
    });
  });

  describe('buildDestinationPreview', () => {
    it('should combine destination base and filename properly', () => {
      expect(buildDestinationPreview('gdrive:', 'custom.zip', 'inferred.zip')).toBe(
        'gdrive:custom.zip'
      );
      expect(buildDestinationPreview('gdrive:backups', '', 'inferred.zip')).toBe(
        'gdrive:backups/inferred.zip'
      );
      expect(buildDestinationPreview('gdrive:backups/', '', 'inferred.zip')).toBe(
        'gdrive:backups/inferred.zip'
      );
      expect(buildDestinationPreview('/home/user/downloads', 'video.mp4', '')).toBe(
        '/home/user/downloads/video.mp4'
      );
      expect(buildDestinationPreview('C:\\Downloads', 'file.txt', '')).toBe(
        'C:\\Downloads\\file.txt'
      );
    });

    it('should handle empty base path or empty filenames gracefully', () => {
      expect(buildDestinationPreview('', 'file.txt', '')).toBe('file.txt');
      expect(buildDestinationPreview('remote:folder', '', '')).toBe('remote:folder');
      expect(buildDestinationPreview('', '', '')).toBe('');
    });
  });
});
