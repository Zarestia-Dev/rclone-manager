import { Injectable } from '@angular/core';
import { RcConfigOption } from '@app/types';
import { isIntType, isFloatType } from 'src/app/shared/utils';

@Injectable({ providedIn: 'root' })
export class RcloneValueMapperService {
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

  nanosecondsToDuration(nanoseconds: number, fallback = 'off'): string {
    if (nanoseconds === 0) return '0s';
    if (nanoseconds < 0 || nanoseconds >= 9e18) return fallback;

    let remaining = nanoseconds;
    let result = '';

    const h = Math.floor(remaining / 3600000000000);
    if (h > 0) {
      result += `${h}h`;
      remaining %= 3600000000000;
    }

    const m = Math.floor(remaining / 60000000000);
    if (m > 0 || result) {
      result += `${m}m`;
      remaining %= 60000000000;
    }

    const s = Math.floor(remaining / 1000000000);
    if (s > 0 || result) {
      result += `${s}s`;
      remaining %= 1000000000;
    }

    if (!result) {
      const ms = Math.floor(remaining / 1000000);
      if (ms > 0) {
        result += `${ms}ms`;
        remaining %= 1000000;
      }
      const us = Math.floor(remaining / 1000);
      if (us > 0) {
        result += `${us}us`;
        remaining %= 1000;
      }
      if (remaining > 0) result += `${remaining}ns`;
    }

    return result || '0s';
  }

  bytesToSize(bytes: number, fallback = ''): string {
    if (bytes === -1) return 'off';
    if (bytes === 0) return '0';
    if (bytes < 0) return fallback;

    const units = [
      { s: 'Pi', v: 1125899906842624 },
      { s: 'Ti', v: 1099511627776 },
      { s: 'Gi', v: 1073741824 },
      { s: 'Mi', v: 1048576 },
      { s: 'Ki', v: 1024 },
    ];

    for (const u of units) {
      if (bytes >= u.v) {
        const val = bytes / u.v;
        return `${bytes % u.v === 0 ? val : Math.round(val * 100) / 100}${u.s}`;
      }
    }
    return `${bytes}B`;
  }

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

  parseFileMode(value: unknown): unknown {
    if (typeof value === 'string' && value.trim()) {
      const parsed = parseInt(value, 8);
      return isNaN(parsed) ? value : parsed;
    }
    return value;
  }

  parseTristate(value: unknown): boolean | null {
    if (value == null || value === '') return null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'object' && 'Valid' in value && 'Value' in value) {
      return (value as { Valid: boolean; Value: boolean }).Valid ? (value as any).Value : null;
    }
    const s = String(value).toLowerCase().trim();
    if (s === 'unset' || s === 'null' || s === '[object object]') return null;
    return s === 'true' ? true : s === 'false' ? false : null;
  }

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

  private normalizeList(val: unknown, type: string): string {
    const isSpace = type === 'SpaceSepList';
    if (Array.isArray(val))
      return val
        .map(String)
        .map(s => s.trim())
        .filter(Boolean)
        .join(isSpace ? ' ' : ',');
    if (val == null) return '';
    return String(val)
      .split(isSpace ? /\s+/ : /,/)
      .map(s => s.trim())
      .filter(Boolean)
      .join(isSpace ? ' ' : ',');
  }

  isDefaultValue(value: unknown, field: RcConfigOption): boolean {
    if (value == null) return true;

    if (field.Type === 'Tristate') {
      const valBool = this.parseTristate(value);
      return (
        valBool === this.parseTristate(field.Default) ||
        valBool === this.parseTristate(field.DefaultStr) ||
        (valBool === null && field.Default == null && field.DefaultStr == null)
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

  humanToMachine(value: unknown, type: string): unknown {
    if (isIntType(type)) {
      if (typeof value !== 'string' || !value.trim()) return value;
      const p = parseInt(value, 10);
      return isNaN(p) ? value : p;
    }
    if (isFloatType(type)) {
      if (typeof value !== 'string' || !value.trim()) return value;
      const p = parseFloat(value);
      return isNaN(p) ? value : p;
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
        return typeof value === 'string'
          ? value
              .split(',')
              .map(v => v.trim())
              .filter(Boolean)
              .join(',')
          : value;
      case 'SpaceSepList':
        if (Array.isArray(value)) return value.join(' ');
        return typeof value === 'string'
          ? value.trim().split(/\s+/).filter(Boolean).join(' ')
          : value;
      default:
        return value;
    }
  }
}
