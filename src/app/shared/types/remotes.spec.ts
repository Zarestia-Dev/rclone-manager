import { describe, it, expect } from 'vitest';
import {
  createDefaultRemoteStatus,
  createDefaultRemoteOperationState,
  createDefaultRemoteFeatures,
} from './remotes';

describe('Remote Factory Functions', () => {
  describe('createDefaultRemoteOperationState', () => {
    it('creates an inactive operation state', () => {
      const state = createDefaultRemoteOperationState();
      expect(state).toEqual({ active: false });
    });
  });

  describe('createDefaultRemoteStatus', () => {
    it('creates complete remote status with all operation states initialized', () => {
      const status = createDefaultRemoteStatus();

      expect(status.diskUsage).toEqual({});
      expect(status.mount).toEqual({ active: false });
      expect(status.sync).toEqual({ active: false });
      expect(status.copy).toEqual({ active: false });
      expect(status.bisync).toEqual({ active: false });
      expect(status.move).toEqual({ active: false });
      expect(status.check).toEqual({ active: false });
      expect(status.delete).toEqual({ active: false });
      expect(status.copyurl).toEqual({ active: false });
      expect(status.archivecreate).toEqual({ active: false });
      expect(status.cryptcheck).toEqual({ active: false });
      expect(status.serve).toEqual({ active: false, count: 0, serves: [] });
    });
  });

  describe('createDefaultRemoteFeatures', () => {
    it('creates remote features with default values', () => {
      const features = createDefaultRemoteFeatures(false, false);
      expect(features.IsLocal).toBe(false);
      expect(features.loading).toBe(false);
      expect(features.About).toBe(false);
      expect(features.BucketBased).toBe(false);
      expect(features.Hashes).toEqual([]);
    });

    it('respects isLocal and loading flags', () => {
      const features = createDefaultRemoteFeatures(true, true);
      expect(features.IsLocal).toBe(true);
      expect(features.loading).toBe(true);
    });
  });
});
