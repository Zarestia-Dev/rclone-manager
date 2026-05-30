import { Injectable } from '@angular/core';
import { RcConfigOption } from '@app/types';

/**
 * Service for converting between rclone's machine values and human-readable formats
 */
@Injectable({
  providedIn: 'root',
})
export class RcloneValueMapperService {
  private static readonly INT_TYPES = new Set([
    'int',
    'int64',
    'int32',
    'uint',
    'uint32',
    'uint64',
  ]);
  private static readonly FLOAT_TYPES = new Set(['float', 'float32', 'float64']);

  /**
   * Convert a machine value to human-readable format based on type
   */
  machineToHuman(value: unknown, type: string, fallback = ''): string {
    if (value == null) return fallback;

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
   */
  nanosecondsToDuration(nanoseconds: number, fallback = 'off'): string {
    if (nanoseconds === 0) return '0s';
    if (nanoseconds < 0 || nanoseconds >= 9e18) return fallback;

    const units = [
      { label: 'h', val: 3600000000000 },
      { label: 'm', val: 60000000000 },
      { label: 's', val: 1000000000 },
    ];

    let result = '';
    let remaining = nanoseconds;

    for (const { label, val } of units) {
      const amount = Math.floor(remaining / val);
      if (amount > 0 || (result && label === 's')) {
        result += `${amount}${label}`;
        remaining %= val;
      }
    }

    if (!result) {
      const subUnits = [
        { label: 'ms', val: 1000000 },
        { label: 'us', val: 1000 },
        { label: 'ns', val: 1 },
      ];
      for (const { label, val } of subUnits) {
        const amount = Math.floor(remaining / val);
        if (amount > 0) {
          result += `${amount}${label}`;
          remaining %= val;
        }
      }
    }

    return result || '0s';
  }

  /**
   * Convert bytes to size string (e.g., -1 → "off", 102400 → "100Ki")
   */
  bytesToSize(bytes: number, fallback = ''): string {
    if (bytes === -1) return 'off';
    if (bytes === 0) return '0';
    if (bytes < 0) return fallback;

    const units = [
      { suffix: 'Pi', value: 1125899906842624 },
      { suffix: 'Ti', value: 1099511627776 },
      { suffix: 'Gi', value: 1073741824 },
      { suffix: 'Mi', value: 1048576 },
      { suffix: 'Ki', value: 1024 },
      { suffix: 'B', value: 1 },
    ];

    const unit = units.find(u => bytes >= u.value);
    if (!unit) return `${bytes}B`;

    const val = bytes / unit.value;
    return `${bytes % unit.value === 0 ? val : Math.round(val * 100) / 100}${unit.suffix}`;
  }

  /**
   * Convert numeric file mode to octal string (e.g., 18 → "022", 511 → "777")
   */
  fileModeToString(value: number | string | null | undefined, fallback = ''): string {
    if (value == null) return fallback;
    const minWidth = Math.max(3, fallback.length);

    if (typeof value === 'number') {
      if (value < 0) return fallback;
      return (value & 0o7777).toString(8).padStart(minWidth, '0');
    }

    const s = String(value).trim();
    return s ? s.padStart(minWidth, '0') : fallback;
  }

  /**
   * Parse octal string to numeric file mode (e.g., "777" → 511)
   */
  parseFileMode(value: unknown): unknown {
    if (typeof value === 'string' && value.trim()) {
      const parsed = parseInt(value, 8);
      return isNaN(parsed) ? value : parsed;
    }
    return value;
  }

  /**
   * Parse a Tristate value to boolean or null
   */
  parseTristate(value: unknown): boolean | null {
    if (value == null || value === '') return null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'object' && 'Valid' in value && 'Value' in value) {
      const obj = value as { Valid: boolean; Value: boolean };
      return obj.Valid ? obj.Value : null;
    }
    const s = String(value).toLowerCase().trim();
    if (s === 'unset' || s === 'null' || s === '[object object]') return null;
    return s === 'true' ? true : s === 'false' ? false : null;
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
   * Checks if a config value matches its default state.
   */
  private normalizeList(val: unknown, type: string): string {
    const sep = type === 'SpaceSepList' ? ' ' : ',';
    const regex = type === 'SpaceSepList' ? /\s+/ : /,/;
    if (Array.isArray(val)) {
      return val
        .map(s => String(s).trim())
        .filter(Boolean)
        .join(sep);
    }
    if (val == null) return '';
    return String(val)
      .split(regex)
      .map(s => s.trim())
      .filter(Boolean)
      .join(sep);
  }

  /**
   * Checks if a config value matches its default state.
   */
  isDefaultValue(value: unknown, field: RcConfigOption): boolean {
    if (value == null) return true;

    if (field.Type === 'Tristate') {
      const valBool = this.parseTristate(value);
      const defBool = this.parseTristate(field.Default);
      const defStrBool = this.parseTristate(field.DefaultStr);
      return (
        valBool === defBool ||
        valBool === defStrBool ||
        (valBool === null && defBool === null && defStrBool === null)
      );
    }

    if (Array.isArray(value)) {
      const normVal = this.normalizeList(value, field.Type);
      if (value.length === 0) {
        return (
          field.Default == null ||
          normVal === this.normalizeList(field.Default, field.Type) ||
          normVal === this.normalizeList(field.DefaultStr, field.Type)
        );
      }
      return (
        normVal === this.normalizeList(field.Default, field.Type) ||
        normVal === this.normalizeList(field.DefaultStr, field.Type)
      );
    }

    const strVal = String(value);
    return strVal === String(field.Default) || strVal === String(field.DefaultStr) || strVal === '';
  }

  /**
   * Convert string value to appropriate type for backend
   */
  humanToMachine(value: unknown, type: string): unknown {
    if (RcloneValueMapperService.INT_TYPES.has(type)) {
      if (typeof value !== 'string' || !value.trim()) return value;
      const parsed = parseInt(value, 10);
      return isNaN(parsed) ? value : parsed;
    }

    if (RcloneValueMapperService.FLOAT_TYPES.has(type)) {
      if (typeof value !== 'string' || !value.trim()) return value;
      const parsed = parseFloat(value);
      return isNaN(parsed) ? value : parsed;
    }

    switch (type) {
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
        if (typeof value === 'string') {
          return value
            .split(',')
            .map(v => v.trim())
            .filter(Boolean)
            .join(',');
        }
        return value;
      case 'SpaceSepList':
        if (Array.isArray(value)) return value.join(' ');
        if (typeof value === 'string') {
          return value.trim().split(/\s+/).filter(Boolean).join(' ');
        }
        return value;
      default:
        return value;
    }
  }
}
