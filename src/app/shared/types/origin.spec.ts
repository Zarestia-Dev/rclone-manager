import { describe, expect, it } from 'vitest';
import {
  getExecutionOrigin,
  getStarterOrigin,
  isProfileScoped,
  matchesOriginFilter,
  ExecutionScope,
  Origin,
} from './origin';

describe('getExecutionOrigin', () => {
  it.each<[ExecutionScope, Origin]>([
    [{}, 'dashboard'],
    [{ origin: 'automation' }, 'automation'],
    [{ origin: 'filemanager' }, 'filemanager'],
    [{ origin: 'quickrun' }, 'quickrun'],
    [{ origin: 'workflow' }, 'workflow'],
    [{ origin: 'dashboard', starter: { kind: 'quick_run', id: 'qr', name: 'qr' } }, 'quickrun'],
    [
      {
        origin: 'automation',
        starter: {
          kind: 'workflow',
          workflowId: 'wf',
          workflowName: 'Workflow',
          nodeId: 'node',
          ancestors: [],
        },
      },
      'workflow',
    ],
    [
      {
        origin: 'quickrun',
        starter: {
          kind: 'quick_run',
          id: 'qr',
          name: 'qr',
          workflow: { workflowId: 'wf', workflowName: 'Workflow', nodeId: 'node', ancestors: [] },
        },
      },
      'workflow',
    ],
    [{ origin: 'workflow' }, 'workflow'],
  ])('classifies %j as %s', (scope, expected) => {
    expect(getExecutionOrigin(scope)).toBe(expected);
  });
});

describe('isProfileScoped', () => {
  it.each<ExecutionScope>([
    {},
    { origin: 'dashboard' },
    { origin: 'automation' },
    { origin: 'startup' },
  ])('includes profile execution %j', scope => {
    expect(isProfileScoped(scope)).toBe(true);
  });
  it.each<ExecutionScope>([
    { origin: 'workflow' },
    { origin: 'quickrun' },
    { starter: { kind: 'quick_run', id: 'qr', name: 'qr' } },
    {
      starter: {
        kind: 'workflow',
        workflowId: 'wf',
        workflowName: 'Workflow',
        nodeId: 'node',
        ancestors: [],
      },
      origin: 'automation',
    },
  ])('excludes dedicated execution %j', scope => {
    expect(isProfileScoped(scope)).toBe(false);
  });
});

describe('getStarterOrigin', () => {
  const run = { workflowId: 'wf', workflowName: 'Workflow', nodeId: 'n1', ancestors: [] };

  it.each<[ExecutionScope, Origin | undefined]>([
    [{ starter: { kind: 'workflow', ...run } }, 'workflow'],
    // A node that ran a Quick Run is still Flow work.
    [{ starter: { kind: 'quick_run', id: 'qr', name: 'qr', workflow: run } }, 'workflow'],
    [{ starter: { kind: 'quick_run', id: 'qr', name: 'qr' } }, 'quickrun'],
    [{ starter: { kind: 'profile', name: 'daily' } }, undefined],
    [{ origin: 'quickrun' }, undefined],
    [{}, undefined],
  ])('%j implies %s', (scope, expected) => {
    expect(getStarterOrigin(scope)).toBe(expected);
  });

  it('wins over the stored origin', () => {
    expect(getExecutionOrigin({ origin: 'dashboard', starter: { kind: 'workflow', ...run } })).toBe(
      'workflow'
    );
  });
});

describe('matchesOriginFilter', () => {
  const quickRun: ExecutionScope = {
    origin: 'dashboard',
    starter: { kind: 'quick_run', id: 'qr', name: 'qr' },
  };
  const workflow: ExecutionScope = { origin: 'workflow' };

  it('keeps everything under "all"', () => {
    for (const item of [{}, quickRun, workflow, { origin: 'startup' }] as ExecutionScope[]) {
      expect(matchesOriginFilter(item, 'all')).toBe(true);
    }
  });

  it.each<Origin | undefined>([undefined, 'dashboard', 'automation', 'filemanager', 'startup'])(
    'counts work of origin %s as dashboard: a remote profile owns it',
    origin => {
      expect(matchesOriginFilter({ origin }, 'dashboard')).toBe(true);
    }
  );

  it('keeps Quick Run and workflow work out of dashboard, and under its own chip', () => {
    expect(matchesOriginFilter(quickRun, 'dashboard')).toBe(false);
    expect(matchesOriginFilter(workflow, 'dashboard')).toBe(false);
    expect(matchesOriginFilter(quickRun, 'quickrun')).toBe(true);
    expect(matchesOriginFilter(workflow, 'workflow')).toBe(true);
    expect(matchesOriginFilter(quickRun, 'workflow')).toBe(false);
  });

  it('matches any other chip by the origin itself', () => {
    expect(matchesOriginFilter({ origin: 'filemanager' }, 'filemanager')).toBe(true);
    expect(matchesOriginFilter({ origin: 'filemanager' }, 'startup')).toBe(false);
  });
});
