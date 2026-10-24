import { describe, expect, it } from 'vitest';
import { getExecutionOrigin, isProfileScoped, ExecutionScope, Origin } from './origin';

describe('getExecutionOrigin', () => {
  it.each<[ExecutionScope, Origin]>([
    [{}, 'dashboard'],
    [{ origin: 'automation' }, 'automation'],
    [{ origin: 'filemanager' }, 'filemanager'],
    [{ origin: 'quickrun' }, 'quickrun'],
    [{ origin: 'flow' }, 'flow'],
    [{ origin: 'dashboard', quick_run_id: 'qr' }, 'quickrun'],
    [{ origin: 'automation', workflow_id: 'wf' }, 'flow'],
    [{ origin: 'quickrun', workflow_id: 'wf', quick_run_id: 'qr' }, 'flow'],
    [{ origin: 'flow', quick_run_id: 'qr' }, 'flow'],
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
    { origin: 'flow' },
    { origin: 'quickrun' },
    { quick_run_id: 'qr' },
    { workflow_id: 'wf', origin: 'automation' },
  ])('excludes dedicated execution %j', scope => {
    expect(isProfileScoped(scope)).toBe(false);
  });
});
