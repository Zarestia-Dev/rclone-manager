import { describe, it, expect } from 'vitest';
import {
  computeTemplateDiff,
  filterTemplateValues,
  isValueEmpty,
  getApplicableTemplateCategories,
} from './template-diff.utils';
import { TemplateCategory, TEMPLATE_CATEGORIES } from '@app/types';

describe('template-diff.utils', () => {
  describe('getApplicableTemplateCategories', () => {
    it('should return all categories when context is null or undefined', () => {
      expect(getApplicableTemplateCategories(null)).toEqual(TEMPLATE_CATEGORIES);
      expect(getApplicableTemplateCategories(undefined)).toEqual(TEMPLATE_CATEGORIES);
    });

    it('should return only remote category for remote context', () => {
      expect(getApplicableTemplateCategories('remote')).toEqual(['remote']);
    });

    it('should return only shared category for shared profiles', () => {
      expect(getApplicableTemplateCategories('vfs')).toEqual(['vfs']);
      expect(getApplicableTemplateCategories('filter')).toEqual(['filter']);
      expect(getApplicableTemplateCategories('backend')).toEqual(['backend']);
      expect(getApplicableTemplateCategories('runtimeRemote')).toEqual([]);
    });

    it('should return operation and linked profiles without vfs for non-vfs operations like sync and copy', () => {
      expect(getApplicableTemplateCategories('sync')).toEqual(['sync', 'filter', 'backend']);
      expect(getApplicableTemplateCategories('copy')).toEqual(['copy', 'filter', 'backend']);
      expect(getApplicableTemplateCategories('move')).toEqual(['move', 'filter', 'backend']);
      expect(getApplicableTemplateCategories('bisync')).toEqual(['bisync', 'filter', 'backend']);
      expect(getApplicableTemplateCategories('check')).toEqual(['check', 'filter', 'backend']);
    });

    it('should return operation with vfs, filter, and backend for operations supporting vfs (mount, serve)', () => {
      expect(getApplicableTemplateCategories('mount')).toEqual([
        'mount',
        'vfs',
        'filter',
        'backend',
      ]);
      expect(getApplicableTemplateCategories('serve')).toEqual([
        'serve',
        'vfs',
        'filter',
        'backend',
      ]);
    });
  });

  describe('isValueEmpty', () => {
    it('should correctly identify empty and non-empty values', () => {
      expect(isValueEmpty(undefined)).toBe(true);
      expect(isValueEmpty(null)).toBe(true);
      expect(isValueEmpty('')).toBe(true);

      expect(isValueEmpty(false)).toBe(false);
      expect(isValueEmpty(0)).toBe(false);
      expect(isValueEmpty('hello')).toBe(false);
      expect(isValueEmpty([])).toBe(false);
      expect(isValueEmpty({})).toBe(false);
    });
  });

  describe('computeTemplateDiff', () => {
    it('should return empty result when templateValues is undefined or empty', () => {
      const res = computeTemplateDiff();
      expect(res.totalCount).toBe(0);
      expect(res.hasChanges).toBe(false);
      expect(res.items.length).toBe(0);
    });

    it('should mark all template keys as added when currentValues is empty', () => {
      const templateValues: Partial<Record<TemplateCategory, Record<string, unknown>>> = {
        vfs: { dir_cache_time: '1h', vfs_cache_mode: 'full' },
      };

      const res = computeTemplateDiff({}, templateValues);
      expect(res.totalCount).toBe(2);
      expect(res.totalAdded).toBe(2);
      expect(res.totalModified).toBe(0);
      expect(res.totalUnchanged).toBe(0);
      expect(res.hasChanges).toBe(true);

      const vfsItems = res.byCategory.vfs ?? [];
      expect(vfsItems.length).toBe(2);
      expect(vfsItems[0]?.status).toBe('added');
      expect(vfsItems[0]?.currentDisplay).toBe('—');
      expect(vfsItems[0]?.newDisplay).toBe('1h');
    });

    it('should identify modified, unchanged, and added keys', () => {
      const currentValues: Partial<Record<TemplateCategory, Record<string, unknown>>> = {
        vfs: { dir_cache_time: '30m', vfs_cache_mode: 'full' },
        mount: { allow_other: true },
      };

      const templateValues: Partial<Record<TemplateCategory, Record<string, unknown>>> = {
        vfs: {
          dir_cache_time: '2h', // modified
          vfs_cache_mode: 'full', // unchanged
          read_only: true, // added
        },
        mount: {
          allow_other: false, // modified
        },
      };

      const res = computeTemplateDiff(currentValues, templateValues);
      expect(res.totalCount).toBe(4);
      expect(res.totalAdded).toBe(1);
      expect(res.totalModified).toBe(2);
      expect(res.totalUnchanged).toBe(1);
      expect(res.hasChanges).toBe(true);
      expect(res.categories).toEqual(['vfs', 'mount']);

      const dirCacheItem = res.items.find(i => i.id === 'vfs:dir_cache_time');
      expect(dirCacheItem?.status).toBe('modified');
      expect(dirCacheItem?.currentDisplay).toBe('30m');
      expect(dirCacheItem?.newDisplay).toBe('2h');

      const vfsCacheItem = res.items.find(i => i.id === 'vfs:vfs_cache_mode');
      expect(vfsCacheItem?.status).toBe('unchanged');

      const readOnlyItem = res.items.find(i => i.id === 'vfs:read_only');
      expect(readOnlyItem?.status).toBe('added');
    });
  });

  describe('filterTemplateValues', () => {
    const currentValues: Partial<Record<TemplateCategory, Record<string, unknown>>> = {
      vfs: { dir_cache_time: '30m' },
      mount: { allow_other: true },
    };

    const templateValues: Partial<Record<TemplateCategory, Record<string, unknown>>> = {
      vfs: {
        dir_cache_time: '2h',
        vfs_cache_mode: 'full',
      },
      mount: {
        allow_other: false,
        read_only: true,
      },
      sync: {
        fast_list: true,
      },
    };

    it('should filter out categories that are not selected', () => {
      const res = filterTemplateValues(templateValues, {
        strategy: 'overwrite',
        selectedCategories: ['vfs'],
        currentValues,
      });

      expect(res.vfs).toBeDefined();
      expect(res.mount).toBeUndefined();
      expect(res.sync).toBeUndefined();
      expect(res.vfs?.['dir_cache_time']).toBe('2h');
      expect(res.vfs?.['vfs_cache_mode']).toBe('full');
    });

    it('should overwrite all values when strategy is overwrite', () => {
      const res = filterTemplateValues(templateValues, {
        strategy: 'overwrite',
        selectedCategories: ['vfs', 'mount'],
        currentValues,
      });

      expect(res.vfs?.['dir_cache_time']).toBe('2h'); // Overwritten
      expect(res.vfs?.['vfs_cache_mode']).toBe('full');
      expect(res.mount?.['allow_other']).toBe(false); // Overwritten
      expect(res.mount?.['read_only']).toBe(true);
    });

    it('should only fill empty values when strategy is fill-empty', () => {
      const res = filterTemplateValues(templateValues, {
        strategy: 'fill-empty',
        selectedCategories: ['vfs', 'mount'],
        currentValues,
      });

      // dir_cache_time already exists with '30m', so should NOT be in filtered template values
      expect(res.vfs?.['dir_cache_time']).toBeUndefined();
      expect(res.vfs?.['vfs_cache_mode']).toBe('full'); // Was empty, so filled

      // allow_other already exists with true, so should NOT be overwritten
      expect(res.mount?.['allow_other']).toBeUndefined();
      expect(res.mount?.['read_only']).toBe(true); // Was empty, so filled
    });

    it('should respect selectedItemIds filter if provided', () => {
      const res = filterTemplateValues(templateValues, {
        strategy: 'overwrite',
        selectedCategories: ['vfs'],
        currentValues,
        selectedItemIds: new Set(['vfs:vfs_cache_mode']),
      });

      expect(res.vfs?.['dir_cache_time']).toBeUndefined();
      expect(res.vfs?.['vfs_cache_mode']).toBe('full');
    });

    it('should filter out categories that are not in applicableCategories', () => {
      const res = filterTemplateValues(templateValues, {
        strategy: 'overwrite',
        selectedCategories: ['vfs', 'mount', 'sync'],
        currentValues,
        applicableCategories: ['sync', 'backend'],
      });

      expect(res.vfs).toBeUndefined();
      expect(res.mount).toBeUndefined();
      expect(res.sync).toBeDefined();
      expect(res.sync?.['fast_list']).toBe(true);
    });
  });

  describe('computeTemplateDiff with applicableCategories', () => {
    it('should only include categories in applicableCategories and omit excluded ones', () => {
      const templateValues: Partial<Record<TemplateCategory, Record<string, unknown>>> = {
        vfs: { vfs_cache_mode: 'full' },
        mount: { attr_timeout: '10s' },
        sync: { fast_list: true },
      };

      const res = computeTemplateDiff({}, templateValues, ['sync', 'filter', 'backend']);
      expect(res.categories).toEqual(['sync']);
      expect(res.byCategory.vfs).toBeUndefined();
      expect(res.byCategory.mount).toBeUndefined();
      expect(res.byCategory.sync?.length).toBe(1);
      expect(res.totalCount).toBe(1);
    });
  });
});
