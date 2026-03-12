import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class PathService {
  /**
   * Normalize a path by resolving '.' and '..' segments and replacing backslashes.
   */
  normalizePath(p: string): string {
    if (!p) return '';
    const normalized = p.replace(/\\/g, '/');
    const parts = normalized.split('/');
    const stack: string[] = [];
    
    for (const part of parts) {
      if (part === '' || part === '.') continue;
      if (part === '..') {
        if (stack.length > 0) stack.pop();
      } else {
        stack.push(part);
      }
    }
    
    return (normalized.startsWith('/') ? '/' : '') + stack.join('/');
  }

  /**
   * Joins multiple path segments into a single path.
   */
  joinPath(...segments: string[]): string {
    return this.normalizePath(segments.join('/'));
  }

  /**
   * Extracts the filename (last component) from a path.
   */
  getFilename(path: string): string {
    if (!path) return '';
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/');
    return parts[parts.length - 1];
  }

  /**
   * Gets the directory name of a path.
   */
  getDirname(path: string): string {
    if (!path) return '';
    const normalized = path.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash === -1) return '';
    return normalized.substring(0, lastSlash);
  }
}
