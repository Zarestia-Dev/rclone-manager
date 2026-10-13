/**
 * Utilities for URL parsing, decomposition, and target path inference.
 */

export interface ParsedUrlInfo {
  isValid: boolean;
  raw: string;
  protocol?: string;
  protocolType?: string;
  protocolLabel?: string;
  protocolIcon?: string;
  hostname?: string;
  pathname?: string;
  inferredFilename?: string;
  extension?: string;
  isHttps?: boolean;
}

/**
 * Checks if a string has a valid bare domain or IP address structure.
 */
function isValidBareHost(hostAndPath: string): boolean {
  const hostPart = hostAndPath.split('/')[0].split(':')[0].trim();
  if (!hostPart) return false;
  if (hostPart.toLowerCase() === 'localhost') return true;

  // IPv4 check: e.g. 192.168.1.1 or 127.0.0.1
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostPart)) {
    return hostPart.split('.').every(num => {
      const n = parseInt(num, 10);
      return n >= 0 && n <= 255;
    });
  }

  // Domain with at least one dot and a valid TLD (at least 2 letters)
  if (
    /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/.test(
      hostPart
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Map protocol scheme to UI metadata (type, label, icon).
 */
function getProtocolMeta(protocol: string): { type: string; label: string; icon: string } {
  const clean = protocol.replace(':', '').toLowerCase();
  switch (clean) {
    case 'https':
      return { type: 'https', label: 'HTTPS', icon: 'lock' };
    case 'http':
      return { type: 'http', label: 'HTTP', icon: 'globe' };
    case 'ftp':
      return { type: 'ftp', label: 'FTP', icon: 'ftp' };
    case 'ftps':
      return { type: 'ftps', label: 'FTPS', icon: 'ftp' };
    case 'sftp':
      return { type: 'sftp', label: 'SFTP', icon: 'sftp' };
    case 'webdav':
    case 'webdavs':
      return { type: 'webdav', label: 'WebDAV', icon: 'webdav' };
    case 's3':
      return { type: 's3', label: 'S3', icon: 's3' };
    default:
      return { type: clean, label: clean.toUpperCase(), icon: 'globe' };
  }
}

/**
 * Safely parse a URL string and extract relevant path and filename components.
 */
export function parseUrlInfo(urlInput: string | null | undefined): ParsedUrlInfo {
  const raw = (urlInput ?? '').trim();
  if (!raw) {
    return { isValid: false, raw: '' };
  }

  try {
    let urlToParse = raw;
    const hasScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(raw);

    if (!hasScheme) {
      if (raw.startsWith('//')) {
        urlToParse = `https:${raw}`;
      } else if (isValidBareHost(raw)) {
        urlToParse = `https://${raw}`;
      } else {
        // Not a valid URL or host (e.g. single word text like "viewer-btn")
        return { isValid: false, raw };
      }
    }

    const parsed = new URL(urlToParse);
    const protocol = parsed.protocol.toLowerCase();
    const hostname = parsed.hostname;
    const pathname = parsed.pathname;
    const isHttps = protocol === 'https:';
    const protoMeta = getProtocolMeta(protocol);

    // Hostname must be present for a valid network URL
    if (!hostname && protocol !== 'file:') {
      return { isValid: false, raw };
    }

    // Extract the last non-empty segment of the pathname
    const segments = pathname.split('/').filter(Boolean);
    let inferredFilename = '';

    if (segments.length > 0) {
      const rawSegment = segments[segments.length - 1];
      try {
        inferredFilename = decodeURIComponent(rawSegment);
      } catch {
        inferredFilename = rawSegment;
      }
      // Remove any trailing semicolon / matrix parameters if present
      inferredFilename = inferredFilename.split(';')[0];
    }

    // Extract extension
    let extension = '';
    if (inferredFilename && inferredFilename.includes('.')) {
      const parts = inferredFilename.split('.');
      if (parts.length > 1 && parts[parts.length - 1].length <= 10) {
        extension = parts.pop()?.toLowerCase() || '';
      }
    }

    return {
      isValid: true,
      raw,
      protocol,
      protocolType: protoMeta.type,
      protocolLabel: protoMeta.label,
      protocolIcon: protoMeta.icon,
      hostname,
      pathname,
      inferredFilename,
      extension,
      isHttps,
    };
  } catch {
    return {
      isValid: false,
      raw,
    };
  }
}

/**
 * Extract an inferred filename from a URL string.
 */
export function extractFilenameFromUrl(url: string | null | undefined): string {
  const info = parseUrlInfo(url);
  return info.isValid && info.inferredFilename ? info.inferredFilename : '';
}

/**
 * Build destination path preview given a base path and optional custom/inferred filenames.
 */
export function buildDestinationPreview(
  destinationBasePath: string | null | undefined,
  customFilename?: string | null,
  inferredFilename?: string | null
): string {
  const base = (destinationBasePath ?? '').trim();
  const filename = (customFilename ?? '').trim() || (inferredFilename ?? '').trim();

  if (!base && !filename) return '';
  if (!base) return filename;
  if (!filename) return base;

  // Remote with colon: e.g. "gdrive:" or "gdrive:folder" or local path "/home/user"
  if (base.endsWith(':') || base.endsWith('/') || base.endsWith('\\')) {
    return `${base}${filename}`;
  }

  // Choose separator based on path style
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return `${base}${separator}${filename}`;
}
