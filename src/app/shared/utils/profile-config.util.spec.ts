import { describe, it, expect } from 'vitest';
import {
  getAppCfg,
  getRcloneCfg,
  parseTypedValue,
  formatValueDisplay,
  extractProfileSource,
  extractProfileDest,
  getAppConfigValues,
  getRuntimeRemoteProfiles,
} from './profile-config.util';
import { APP_CONFIG_DEFAULTS } from '../types/remote-config';

describe('profile-config.util', () => {
  describe('extractProfileSource', () => {
    it('returns undefined for non-object, null, or empty', () => {
      expect(extractProfileSource(null)).toBeUndefined();
      expect(extractProfileSource(undefined)).toBeUndefined();
      expect(extractProfileSource({})).toBeUndefined();
    });

    it('extracts srcFs as first priority', () => {
      expect(extractProfileSource({ srcFs: 'drive:source', fs: 'drive:other' })).toBe(
        'drive:source'
      );
    });

    it('extracts path1 for bisync when srcFs is absent', () => {
      expect(extractProfileSource({ path1: 'drive:p1' })).toBe('drive:p1');
    });

    it('extracts fs for mount/serve when srcFs and path1 are absent', () => {
      expect(extractProfileSource({ fs: 'drive:fs' })).toBe('drive:fs');
    });

    it('extracts legacy source and url keys as fallback', () => {
      expect(extractProfileSource({ source: 'drive:legacy' })).toBe('drive:legacy');
      expect(extractProfileSource({ url: 'https://example.com' })).toBe('https://example.com');
    });

    it('supports array values for multi-path sync', () => {
      expect(extractProfileSource({ srcFs: ['drive:p1', 'drive:p2'] })).toEqual([
        'drive:p1',
        'drive:p2',
      ]);
    });
  });

  describe('extractProfileDest', () => {
    it('returns undefined for non-object, null, or empty', () => {
      expect(extractProfileDest(null)).toBeUndefined();
      expect(extractProfileDest(undefined)).toBeUndefined();
      expect(extractProfileDest({})).toBeUndefined();
    });

    it('extracts mountPoint as first priority', () => {
      expect(extractProfileDest({ mountPoint: '/mnt/data', dstFs: 'drive:dst' })).toBe('/mnt/data');
    });

    it('extracts dstFs when mountPoint is absent', () => {
      expect(extractProfileDest({ dstFs: 'drive:dst' })).toBe('drive:dst');
    });

    it('extracts path2 for bisync', () => {
      expect(extractProfileDest({ path2: 'drive:p2' })).toBe('drive:p2');
    });

    it('extracts dest as fallback', () => {
      expect(extractProfileDest({ dest: 'drive:legacy-dest' })).toBe('drive:legacy-dest');
    });
  });

  describe('getAppCfg & getRcloneCfg', () => {
    it('picks subconfigs safely', () => {
      const config = {
        app: { autoStart: true },
        rclone: { fs: 'drive:data' },
      };
      expect(getAppCfg(config)).toEqual({ autoStart: true });
      expect(getRcloneCfg(config)).toEqual({ fs: 'drive:data' });
    });

    it('returns null for missing or invalid subconfigs', () => {
      expect(getAppCfg(null)).toBeNull();
      expect(getAppCfg({})).toBeNull();
      expect(getRcloneCfg(undefined)).toBeNull();
      expect(getRcloneCfg({ rclone: 'not-an-object' })).toBeNull();
    });

    it.each([null, undefined, false, 0, '', [], ['invalid']])(
      'rejects invalid partitions: %j',
      value => {
        expect(getAppCfg({ app: value })).toBeNull();
        expect(getRcloneCfg({ rclone: value })).toBeNull();
      }
    );
  });

  it('resolves application defaults without consuming path or flag fields', () => {
    const values = {
      autoStart: true,
      showOnTray: false,
      watchDelay: 0,
      filterProfile: '',
      source: 'drive:',
      options: {},
    };
    const resolved = getAppConfigValues(values);
    expect(resolved).toEqual({ ...APP_CONFIG_DEFAULTS, autoStart: true, watchDelay: 0 });
    expect(resolved['showOnTray']).toBeUndefined();
    expect(values.filterProfile).toBe('');
    resolved['autoStart'] = false;
    expect(getAppConfigValues(values)['autoStart']).toBe(true);
    expect(getAppConfigValues({})).toEqual(APP_CONFIG_DEFAULTS);
  });

  it('defaults the auto-start delay to zero and keeps an explicit one', () => {
    expect(getAppConfigValues({})['autoStartDelay']).toBe(0);
    expect(getAppConfigValues({ autoStartDelay: '' })['autoStartDelay']).toBe(0);
    expect(getAppConfigValues({ autoStartDelay: 30 })['autoStartDelay']).toBe(30);
  });

  it('distinguishes legacy runtime flags from profiles scoped to other remotes', () => {
    expect(getRuntimeRemoteProfiles({}, 'drive')).toEqual({});
    expect(getRuntimeRemoteProfiles({ region: 'us', env_auth: false }, 'drive')).toEqual({
      drive: { region: 'us', env_auth: false },
    });
    const scoped = { other: { region: 'eu' } };
    expect(getRuntimeRemoteProfiles(scoped, 'drive')).toEqual(scoped);
    expect(getRuntimeRemoteProfiles(scoped, 'drive')['drive']).toBeUndefined();
  });

  describe('parseTypedValue & formatValueDisplay', () => {
    it('parses booleans, numbers, and json', () => {
      expect(parseTypedValue('true')).toBe(true);
      expect(parseTypedValue('false')).toBe(false);
      expect(parseTypedValue('42')).toBe(42);
      expect(parseTypedValue('3.14')).toBe(3.14);
      expect(parseTypedValue('{"a":1}')).toEqual({ a: 1 });
      expect(parseTypedValue('[1, 2]')).toEqual([1, 2]);
      expect(parseTypedValue('plain text')).toBe('plain text');
    });

    it('formats values for display', () => {
      expect(formatValueDisplay(true)).toBe('true');
      expect(formatValueDisplay(false)).toBe('false');
      expect(formatValueDisplay({ a: 1 })).toBe('{"a":1}');
      expect(formatValueDisplay(123)).toBe('123');
    });
  });
});
