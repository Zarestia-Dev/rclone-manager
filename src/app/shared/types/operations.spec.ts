import { describe, it, expect } from 'vitest';
import {
  ActionState,
  isOperationActionInProgress,
  isFolderOpeningAction,
  findInFlightAction,
  NO_ACTIONS,
  NON_JOB_OPS,
  SYNC_TYPES,
} from './operations';
import {
  OPERATION_REGISTRY,
  OperationFlag,
  getOperationDef,
  isSourceOnlyOperation,
  operationHas,
} from './operation-registry';
import {
  ALL_PANELS,
  applyPanelLayout,
  defaultPanels,
  isActiveOnTab,
  operationsOfTab,
  panelLayoutOf,
} from './ui';
import { createDefaultRemoteStatus, RemoteStatus } from './remotes';

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

  describe('NO_ACTIONS', () => {
    it('is one frozen empty list, so computeds reading it keep a stable reference', () => {
      expect(NO_ACTIONS).toEqual([]);
      expect(Object.isFrozen(NO_ACTIONS)).toBe(true);
      expect(isOperationActionInProgress(NO_ACTIONS, 'sync')).toBe(false);
    });
  });

  describe('getOperationDef', () => {
    it('finds an operation by key and knows nothing about other keys', () => {
      expect(getOperationDef('sync')?.key).toBe('sync');
      expect(getOperationDef('not-an-operation')).toBeUndefined();
    });
  });

  describe('isSourceOnlyOperation', () => {
    it('is true for the operations that have no destination, and for no other', () => {
      const sourceOnly = OPERATION_REGISTRY.map(op => op.key).filter(isSourceOnlyOperation);

      expect(sourceOnly).toEqual(['delete', 'index']);
      expect(isSourceOnlyOperation('not-an-operation')).toBe(false);
    });
  });

  describe('operationHas', () => {
    const withFlag = (flag: OperationFlag): string[] =>
      OPERATION_REGISTRY.map(op => op.key).filter(key => operationHas(key, flag));

    it('sets each flag on the operations that support it', () => {
      expect(withFlag('watchable')).toEqual(['sync', 'copy', 'move', 'bisync', 'check', 'index']);
      expect(withFlag('multiSource')).toEqual([
        'sync',
        'copy',
        'move',
        'check',
        'delete',
        'copyurl',
        'cryptcheck',
        'index',
      ]);
      expect(withFlag('fileSource')).toEqual(['copy', 'move', 'delete', 'archivecreate']);
      expect(withFlag('backendProfile')).toEqual([
        'sync',
        'copy',
        'move',
        'check',
        'delete',
        'copyurl',
        'archivecreate',
        'index',
      ]);
      expect(withFlag('coreCommand')).toEqual(['archivecreate', 'cryptcheck']);
    });

    it('is false for a key the registry does not know', () => {
      expect(operationHas('not-an-operation', 'watchable')).toBe(false);
    });
  });

  it('NON_JOB_OPS are mount and serve', () => {
    expect([...NON_JOB_OPS]).toEqual(['mount', 'serve']);
  });

  describe('operationsOfTab / isActiveOnTab', () => {
    const running = (op: keyof Omit<RemoteStatus, 'diskUsage'>): { status: RemoteStatus } => {
      const status = createDefaultRemoteStatus();
      status[op].active = true;
      return { status };
    };

    it('maps each tab to the operations it is about', () => {
      expect(operationsOfTab('mount')).toEqual(['mount']);
      expect(operationsOfTab('serve')).toEqual(['serve']);
      expect(operationsOfTab('operations')).toBe(SYNC_TYPES);
      expect(operationsOfTab('general')).toEqual(
        expect.arrayContaining(['mount', 'sync', 'serve'])
      );
    });

    it('is idle when nothing runs', () => {
      const idle = { status: createDefaultRemoteStatus() };
      for (const tab of ['mount', 'operations', 'serve', 'general'] as const) {
        expect(isActiveOnTab(idle, tab)).toBe(false);
      }
    });

    it.each(['sync', 'copy', 'move', 'bisync', 'check', 'cryptcheck', 'delete'] as const)(
      'counts a running %s on the operations tab and the general tab only',
      op => {
        expect(isActiveOnTab(running(op), 'operations')).toBe(true);
        expect(isActiveOnTab(running(op), 'general')).toBe(true);
        expect(isActiveOnTab(running(op), 'mount')).toBe(false);
        expect(isActiveOnTab(running(op), 'serve')).toBe(false);
      }
    );

    it('keeps a mount on the mount tab and a serve on the serve tab', () => {
      expect(isActiveOnTab(running('mount'), 'mount')).toBe(true);
      expect(isActiveOnTab(running('mount'), 'operations')).toBe(false);
      expect(isActiveOnTab(running('serve'), 'serve')).toBe(true);
      expect(isActiveOnTab(running('serve'), 'operations')).toBe(false);
    });
  });

  describe('panel layout', () => {
    const ids = (panels: { id: string }[]): string[] => panels.map(p => p.id);

    it('starts from the built-in order with the default visibility', () => {
      const panels = defaultPanels(ALL_PANELS);

      expect(ids(panels)).toEqual(ALL_PANELS.map(p => p.id));
      expect(panels.every(p => p.visible === true)).toBe(true);
    });

    it.each([null, undefined, [], { order: [], hidden: ['jobs'] }, { hidden: ['jobs'] }])(
      'gives the defaults for the empty layout %j',
      saved => {
        expect(applyPanelLayout(ALL_PANELS, saved)).toEqual(defaultPanels(ALL_PANELS));
      }
    );

    it('applies the saved order and hidden panels', () => {
      const panels = applyPanelLayout(ALL_PANELS, {
        order: ['jobs', 'remotes'],
        hidden: ['remotes'],
      });

      expect(ids(panels).slice(0, 2)).toEqual(['jobs', 'remotes']);
      expect(panels.find(p => p.id === 'jobs')?.visible).toBe(true);
      expect(panels.find(p => p.id === 'remotes')?.visible).toBe(false);
    });

    it('appends panels the layout has not seen with their default visibility', () => {
      const panels = applyPanelLayout(ALL_PANELS, { order: ['jobs'], hidden: [] });

      expect(ids(panels)).toEqual([
        'jobs',
        ...ALL_PANELS.map(p => p.id).filter(id => id !== 'jobs'),
      ]);
      expect(panels.slice(1).every(p => p.visible)).toBe(true);
    });

    it('drops saved panels that no longer exist', () => {
      const panels = applyPanelLayout(ALL_PANELS, { order: ['gone', 'jobs'], hidden: ['gone'] });

      expect(ids(panels)).not.toContain('gone');
      expect(ids(panels)[0]).toBe('jobs');
    });

    it('reads the older layout that was just a list of ids', () => {
      const panels = applyPanelLayout(ALL_PANELS, ['system', 'jobs']);

      expect(ids(panels).slice(0, 2)).toEqual(['system', 'jobs']);
      expect(panels.every(p => p.visible)).toBe(true);
    });

    it('saves exactly what applying it restores', () => {
      const panels = applyPanelLayout(ALL_PANELS, { order: ['system', 'jobs'], hidden: ['jobs'] });
      const saved = panelLayoutOf(panels);

      expect(saved.hidden).toEqual(['jobs']);
      expect(applyPanelLayout(ALL_PANELS, saved)).toEqual(panels);
    });
  });
});
