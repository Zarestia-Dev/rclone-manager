import { Injectable } from '@angular/core';
import { RcConfigOption } from '@app/types';

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
  machineToHuman(value: unknown, type: string, fallback?: string): string {
    if (value === null || value === undefined) {
      return fallback || '';
    }

    switch (type) {
      case 'Duration':
        return this.nanosecondsToDuration(value as number, fallback);

      case 'SizeSuffix':
      case 'BwTimetable':
        return this.bytesToSize(value as number, fallback);

      case 'FileMode':
        return this.fileModeToString(value as number | string, fallback);

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
    if (nanoseconds >= 9e18) return fallback || 'off';

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
      if (bytes >= unit.value) {
        if (bytes % unit.value === 0) return `${bytes / unit.value}${unit.suffix}`;
        return `${Math.round((bytes / unit.value) * 100) / 100}${unit.suffix}`;
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
  parseFileMode(value: string | number | unknown): number | string | unknown {
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = parseInt(value, 8);
      return isNaN(parsed) ? value : parsed;
    }
    return value;
  }

  /**
   * Parse a Tristate value (e.g. from rclone backend) to a boolean or null.
   * Rclone sometimes returns Tristate objects like { Valid: false, Value: false }
   */
  parseTristate(value: unknown): boolean | null {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'object' && 'Valid' in (value as object) && 'Value' in (value as object)) {
      const obj = value as { Valid: boolean; Value: boolean };
      return obj.Valid ? obj.Value : null;
    }
    const s = String(value).toLowerCase().trim();
    // '[object object]' guards against cases where a Tristate object was accidentally
    // passed through String() without being unwrapped first (e.g. stale serialised cache).
    if (s === 'unset' || s === 'null' || s === '[object object]') return null;
    if (s === 'true') return true;
    if (s === 'false') return false;
    return null;
  }

  /**
   * Normalizes an RcConfigOption by unwrapping its Default and Value properties if they are Tristate objects.
   */
  normalizeOption(opt: RcConfigOption): RcConfigOption {
    if (opt.Type === 'Tristate') {
      return {
        ...opt,
        Default: this.parseTristate(opt.Default),
        Value: this.parseTristate(opt.Value),
      };
    }
    return opt;
  }

  /**
   * Convert string value to appropriate type for backend
   */
  humanToMachine(value: unknown, type: string): unknown {
    switch (type) {
      case 'int':
      case 'int64':
      case 'int32':
      case 'uint':
      case 'uint32':
      case 'uint64':
        if (typeof value === 'string' && value.trim() !== '') {
          const numValue = parseInt(value, 10);
          return isNaN(numValue) ? value : numValue;
        }
        return value;

      case 'float':
      case 'float32':
      case 'float64':
        if (typeof value === 'string' && value.trim() !== '') {
          const numValue = parseFloat(value);
          return isNaN(numValue) ? value : numValue;
        }
        return value;

      case 'bool':
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') {
          const s = value.toLowerCase().trim();
          if (s === 'true') return true;
          if (s === 'false') return false;
        }
        return value;

      case 'Tristate':
        return this.parseTristate(value);

      case 'FileMode':
        return this.parseFileMode(value);

      case 'Encoding':
      case 'Bits':
      case 'DumpFlags':
        return Array.isArray(value) ? value.join(',') : value;

      case 'CommaSepList':
        if (Array.isArray(value)) return value.join(',');
        if (typeof value === 'string')
          return value
            .split(',')
            .map(v => v.trim())
            .filter(v => v)
            .join(',');
        return value;

      case 'SpaceSepList':
        if (Array.isArray(value)) return value.join(' ');
        if (typeof value === 'string')
          return value
            .trim()
            .split(/\s+/)
            .filter(v => v)
            .join(' ');
        return value;

      default:
        // Duration, SizeSuffix, BwTimetable, string, etc. - keep as string
        return value;
    }
  }
}
