import { describe, it, expect } from 'vitest';
import {
  ActionState,
  isOperationActionInProgress,
  isFolderOpeningAction,
  findInFlightAction,
} from './operations';

describe('Operation Action Helpers', () => {
  describe('isOperationActionInProgress', () => {
    it('returns false for null, undefined, or empty arrays', () => {
      expect(isOperationActionInProgress(null, 'mount')).toBe(false);
      expect(isOperationActionInProgress(undefined, 'sync')).toBe(false);
      expect(isOperationActionInProgress([], 'copy')).toBe(false);
    });

    it('matches direct operation type match', () => {
      const actions: ActionState[] = [{ type: 'sync', profileName: 'profile1' }];
      expect(isOperationActionInProgress(actions, 'sync')).toBe(true);
      expect(isOperationActionInProgress(actions, 'copy')).toBe(false);
    });

    it('matches mount unmount action', () => {
      const actions: ActionState[] = [{ type: 'unmount' }];
      expect(isOperationActionInProgress(actions, 'mount')).toBe(true);
      expect(isOperationActionInProgress(actions, 'sync')).toBe(false);
    });

    it('matches stop action by operationType', () => {
      const actions: ActionState[] = [{ type: 'stop', operationType: 'bisync', profileName: 'p1' }];
      expect(isOperationActionInProgress(actions, 'bisync')).toBe(true);
      expect(isOperationActionInProgress(actions, 'sync')).toBe(false);
    });

    it('matches by profileName when specified', () => {
      const actions: ActionState[] = [
        { type: 'sync', profileName: 'profile1', operationType: 'sync' },
      ];
      expect(isOperationActionInProgress(actions, 'sync', 'profile1')).toBe(true);
      expect(isOperationActionInProgress(actions, 'sync', 'profile2')).toBe(false);
    });

    it('matches ANY non-open action when opType is omitted', () => {
      expect(isOperationActionInProgress([{ type: 'open' }])).toBe(false);
      expect(isOperationActionInProgress([{ type: 'sync' }])).toBe(true);
      expect(isOperationActionInProgress([{ type: 'stop', operationType: 'mount' }])).toBe(true);
    });
  });

  describe('isFolderOpeningAction', () => {
    it('returns false for null, undefined, or empty arrays', () => {
      expect(isFolderOpeningAction(null)).toBe(false);
      expect(isFolderOpeningAction(undefined)).toBe(false);
      expect(isFolderOpeningAction([])).toBe(false);
    });

    it('returns true when an open action is present', () => {
      const actions: ActionState[] = [{ type: 'open' }];
      expect(isFolderOpeningAction(actions)).toBe(true);
    });

    it('filters by operationType and profileName if provided', () => {
      const actions: ActionState[] = [
        { type: 'open', operationType: 'mount', profileName: 'profile1' },
      ];
      expect(isFolderOpeningAction(actions, 'mount', 'profile1')).toBe(true);
      expect(isFolderOpeningAction(actions, 'mount', 'profile2')).toBe(false);
      expect(isFolderOpeningAction(actions, 'sync', 'profile1')).toBe(false);
    });
  });

  describe('findInFlightAction', () => {
    it('returns undefined if not found', () => {
      expect(findInFlightAction([], 'mount')).toBeUndefined();
      expect(findInFlightAction(null, 'sync')).toBeUndefined();
    });

    it('finds direct matching action', () => {
      const actions: ActionState[] = [{ type: 'mount', profileName: 'p1' }];
      const found = findInFlightAction(actions, 'mount', 'p1');
      expect(found).toBeDefined();
      expect(found?.type).toBe('mount');
    });

    it('finds unmount action for mount type', () => {
      const actions: ActionState[] = [{ type: 'unmount' }];
      const found = findInFlightAction(actions, 'mount');
      expect(found).toBeDefined();
      expect(found?.type).toBe('unmount');
    });

    it('finds stop action for operationType', () => {
      const actions: ActionState[] = [{ type: 'stop', operationType: 'sync', profileName: 'p1' }];
      const found = findInFlightAction(actions, 'sync', 'p1');
      expect(found).toBeDefined();
      expect(found?.type).toBe('stop');
      expect(found?.operationType).toBe('sync');
    });
  });
});
