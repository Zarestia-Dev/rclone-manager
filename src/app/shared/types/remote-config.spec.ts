import { describe, it, expect } from 'vitest';
import { INTERACTIVE_REMOTES, isRclonePathKey } from './remote-config';

describe('Remote Config Types', () => {
  describe('INTERACTIVE_REMOTES', () => {
    const expectedTypes = [
      'jottacloud',
      'onedrive',
      'zoho',
      'seafile',
      'sugarsync',
      'iclouddrive',
      'internxt',
    ];

    it('contains all expected types in the INTERACTIVE_REMOTES set', () => {
      expect(INTERACTIVE_REMOTES.size).toBe(expectedTypes.length);
      for (const type of expectedTypes) {
        expect(INTERACTIVE_REMOTES.has(type)).toBe(true);
      }
    });

    it('returns false for non-interactive types', () => {
      expect(INTERACTIVE_REMOTES.has('s3')).toBe(false);
      expect(INTERACTIVE_REMOTES.has('drive')).toBe(false);
      expect(INTERACTIVE_REMOTES.has('dropbox')).toBe(false);
    });
  });

  describe('RCLONE_PATH_KEYS & isRclonePathKey', () => {
    it('recognizes all canonical path keys', () => {
      const keys = [
        'dstFs',
        'path2',
        'mountPoint',
        'dest',
        'srcFs',
        'path1',
        'fs',
        'source',
        'path',
      ];
      for (const k of keys) {
        expect(isRclonePathKey(k)).toBe(true);
      }
    });

    it('returns false for non-path keys', () => {
      expect(isRclonePathKey('bwlimit')).toBe(false);
      expect(isRclonePathKey('transfers')).toBe(false);
      expect(isRclonePathKey('vfs_cache_mode')).toBe(false);
      expect(isRclonePathKey('')).toBe(false);
    });
  });
});
