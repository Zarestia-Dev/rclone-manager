import { Injectable } from '@angular/core';

/**
 * Service for converting between rclone's machine values and human-readable formats
 */
@Injectable({
  providedIn: 'root',
})
export class RcloneValueMapperService {
  /**
   * Convert a machine value to human-readable format based on type
   */
  machineToHuman(value: any, type: string, fallback?: string): string {
    if (value === null || value === undefined) {
      return fallback || '';
    }

    switch (type) {
      case 'Duration':
        return this.nanosecondsToDuration(value, fallback);

      case 'SizeSuffix':
      case 'BwTimetable':
        return this.bytesToSize(value, fallback);

      case 'FileMode':
        return this.fileModeToString(value, fallback);

      default:
        return String(value);
    }
  }

  /**
   * Convert nanoseconds to duration string (e.g., 60000000000 → "1m0s")
   * Always includes seconds like rclone does (5m → 5m0s)
   */
  nanosecondsToDuration(nanoseconds: number, fallback?: string): string {
    if (nanoseconds === 0) return '0s';
    if (nanoseconds < 0) return fallback || '';

    const hours = Math.floor(nanoseconds / 3600000000000);
    const minutes = Math.floor((nanoseconds % 3600000000000) / 60000000000);
    const seconds = Math.floor((nanoseconds % 60000000000) / 1000000000);
    const milliseconds = Math.floor((nanoseconds % 1000000000) / 1000000);
    const microseconds = Math.floor((nanoseconds % 1000000) / 1000);
    const ns = nanoseconds % 1000;

    let result = '';

    // Add hours if present
    if (hours > 0) result += `${hours}h`;

    // Add minutes if present (or if we have hours)
    if (minutes > 0 || hours > 0) result += `${minutes}m`;

    // Always add seconds if we have hours or minutes, or if seconds > 0
    if (hours > 0 || minutes > 0 || seconds > 0) {
      result += `${seconds}s`;
    }

    // Add smaller units only if no larger units
    if (hours === 0 && minutes === 0 && seconds === 0) {
      if (milliseconds > 0) result += `${milliseconds}ms`;
      if (microseconds > 0) result += `${microseconds}us`;
      if (ns > 0) result += `${ns}ns`;
    }

    return result || '0s';
  }

  /**
   * Convert bytes to size string (e.g., -1 → "off", 102400 → "100Ki")
   */
  bytesToSize(bytes: number, fallback?: string): string {
    // Special cases
    if (bytes === -1) return 'off';
    if (bytes === 0) return '0';
    if (bytes < 0) return fallback || '';

    const units = [
      { suffix: 'Pi', value: 1125899906842624 },
      { suffix: 'Ti', value: 1099511627776 },
      { suffix: 'Gi', value: 1073741824 },
      { suffix: 'Mi', value: 1048576 },
      { suffix: 'Ki', value: 1024 },
      { suffix: 'B', value: 1 },
    ];

    for (const unit of units) {
      if (bytes >= unit.value && bytes % unit.value === 0) {
        return `${bytes / unit.value}${unit.suffix}`;
      }
    }

    // If no exact match, use the closest unit
    for (const unit of units) {
      if (bytes >= unit.value) {
        const value = bytes / unit.value;
        // Round to 2 decimal places
        return `${Math.round(value * 100) / 100}${unit.suffix}`;
      }
    }

    return `${bytes}B`;
  }

  /**
   * Convert numeric file mode to octal string (e.g., 18 → "022", 511 → "777")
   */
  fileModeToString(value: number | string | null | undefined, fallback?: string): string {
    if (value === null || value === undefined) return fallback || '';

    const minWidth = Math.max(3, fallback ? fallback.length : 0);

    if (typeof value === 'number') {
      if (value < 0) return fallback || '';
      const oct = (value & 0o7777).toString(8);
      return oct.length >= minWidth ? oct : oct.padStart(minWidth, '0');
    }

    const s = String(value);
    if (s.trim() === '') return fallback || '';
    return s.length >= minWidth ? s : s.padStart(minWidth, '0');
  }

  /**
   * Parse octal string to numeric file mode (e.g., "777" → 511)
   * Returns the parsed number, or the original value if parsing fails
   */
  parseFileMode(value: any): number | any {
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = parseInt(value, 8);
      return isNaN(parsed) ? value : parsed;
    }
    return value;
  }

  /**
   * Convert string value to appropriate type for backend
   */
  humanToMachine(value: any, type: string): any {
    switch (type) {
      case 'int':
      case 'int64':
      case 'uint32':
        if (typeof value === 'string' && value.trim() !== '') {
          const numValue = parseInt(value, 10);
          return isNaN(numValue) ? value : numValue;
        }
        return value;

      case 'float64':
        if (typeof value === 'string' && value.trim() !== '') {
          const numValue = parseFloat(value);
          return isNaN(numValue) ? value : numValue;
        }
        return value;

      case 'FileMode':
        return this.parseFileMode(value);

      case 'Encoding':
      case 'Bits':
      case 'CommaSepList':
      case 'DumpFlags':
        return Array.isArray(value) ? value.join(',') : value;

      default:
        // Duration, SizeSuffix, BwTimetable, string, etc. - keep as string
        return value;
    }
  }
}
