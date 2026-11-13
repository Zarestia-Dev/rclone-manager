import { describe, expect, it } from 'vitest';
import {
  getExecutionOrigin,
  getStarterOrigin,
  isProfileScoped,
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
