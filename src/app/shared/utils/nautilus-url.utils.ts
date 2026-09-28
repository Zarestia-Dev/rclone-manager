import { encodeUrlPath } from './url.utils';

export interface NautilusLocation {
  remote: string | null;
  path: string;
}

export function buildNautilusPath(remote: string | null, path = ''): string {
  if (!remote) return '/nautilus';
  return `/nautilus/${encodeURIComponent(remote)}${path ? '/' + encodeUrlPath(path) : ''}`;
}

export function parseNautilusPath(pathname: string): NautilusLocation | null {
  if (pathname === '/nautilus' || pathname === '/nautilus/') {
    return { remote: null, path: '' };
  }
  if (!pathname.startsWith('/nautilus/')) return null;
  const [remote, ...segments] = pathname.slice('/nautilus/'.length).split('/');
  if (!remote) return null;
  try {
    return {
      remote: decodeURIComponent(remote),
      path: segments.map(segment => decodeURIComponent(segment)).join('/'),
    };
  } catch {
    return null;
  }
}
