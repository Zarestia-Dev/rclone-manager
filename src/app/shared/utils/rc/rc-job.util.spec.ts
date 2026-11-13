import { describe, it, expect } from 'vitest';
import { toJobProgress, toJobView } from './rc-job.util';

describe('rc-job.util', () => {
  describe('toJobView', () => {
    it('reads a finished job', () => {
      expect(
        toJobView({
          finished: true,
          success: false,
          error: 'boom',
          duration: 2.5,
          output: { a: 1 },
          group: 'job/7',
        })
      ).toEqual({
        finished: true,
        success: false,
        error: 'boom',
        duration: 2.5,
        output: { a: 1 },
        group: 'job/7',
      });
    });

    it('defaults every missing or mistyped field', () => {
      expect(toJobView(null)).toEqual({
        finished: false,
        success: false,
        error: '',
        duration: 0,
        output: undefined,
        group: '',
      });
      expect(toJobView({ finished: 'yes', duration: 'x' }).finished).toBe(false);
    });
  });

  describe('toJobProgress', () => {
    it('computes the percentage and keeps the eta', () => {
      const p = toJobProgress({
        bytes: 50,
        totalBytes: 200,
        speed: 10,
        eta: 15,
        transfers: 1,
        totalTransfers: 4,
        checks: 2,
        errors: 0,
      });
      expect(p).toMatchObject({ percent: 25, eta: 15, totalTransfers: 4 });
    });

    it('has no percentage while the total is unknown', () => {
      expect(toJobProgress({ checks: 3, eta: null })).toMatchObject({ percent: null, eta: null });
    });

    it('caps the percentage at 100', () => {
      expect(toJobProgress({ bytes: 300, totalBytes: 200 })?.percent).toBe(100);
    });

    it('returns null when nothing has started', () => {
      expect(toJobProgress({ bytes: 0, totalBytes: 0 })).toBeNull();
      expect(toJobProgress(null)).toBeNull();
      expect(toJobProgress('x')).toBeNull();
    });
  });
});
