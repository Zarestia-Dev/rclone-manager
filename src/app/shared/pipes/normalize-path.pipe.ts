import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'normalizePath',
  standalone: true,
  pure: true,
})
export class NormalizePathPipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    if (value === null || value === undefined) return '';

    const s = String(value).trim();

    // These prefixes and patterns are overwhelmingly specific to Windows.
    const isWindowsPath =
      s.startsWith('\\\\?\\') ||
      s.startsWith('//?/') ||
      s.startsWith('\\\\.\\') ||
      /^[a-zA-Z]:[\\/]/.test(s) || // Drive letter C:\
      s.toLowerCase().startsWith('unc\\'); // UNC path

    // If it doesn't look like a Windows path, return it as-is.
    // This makes it safe for Unix-style paths like /home/user.
    if (!isWindowsPath) {
      return s;
    }

    // --- Start of Windows Path Normalization Logic ---

    // Normalize all forward slashes to backslashes for consistent processing
    let normalized = s.replace(/\//g, '\\');

    // Remove common Windows extended-length/device prefixes from the start
    if (normalized.startsWith('\\\\?\\')) {
      normalized = normalized.substring(4);
    } else if (normalized.startsWith('\\\\.\\')) {
      normalized = normalized.substring(4);
    }

    // Handle UNC form expressed as UNC\server\share -> convert to \\server\share
    if (normalized.toLowerCase().startsWith('unc\\')) {
      normalized = '\\\\' + normalized.substring(4);
    }

    return normalized;
  }
}
