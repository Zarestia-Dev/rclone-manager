import { describe, expect, it } from 'vitest';
import {
  HasStarter,
  isWorkflowNode,
  profileOf,
  quickRunIdOf,
  quickRunNameOf,
  sameStarter,
  workflowIdOf,
  workflowRunOf,
} from './starter';

describe('starter', () => {
  const profile: HasStarter = { starter: { kind: 'profile', name: 'Daily' } };
  const quickRun: HasStarter = { starter: { kind: 'quick_run', id: 'qr-1', name: 'Nightly' } };
  const adHoc: HasStarter = {};

  it('a profile has no Quick Run and a Quick Run has no profile', () => {
    expect(profileOf(profile)).toBe('Daily');
    expect(quickRunIdOf(profile)).toBeUndefined();
    expect(quickRunNameOf(profile)).toBeUndefined();

    expect(profileOf(quickRun)).toBeUndefined();
    expect(quickRunIdOf(quickRun)).toBe('qr-1');
    expect(quickRunNameOf(quickRun)).toBe('Nightly');
  });

  it('ad hoc work has neither', () => {
    expect(profileOf(adHoc)).toBeUndefined();
    expect(quickRunIdOf(adHoc)).toBeUndefined();
    expect(quickRunNameOf(adHoc)).toBeUndefined();
  });

  it('compares starters by kind, name and id', () => {
    expect(sameStarter(undefined, undefined)).toBe(true);
    expect(sameStarter(profile.starter, { kind: 'profile', name: 'Daily' })).toBe(true);
    expect(sameStarter(quickRun.starter, { kind: 'quick_run', id: 'qr-1', name: 'Nightly' })).toBe(
      true
    );

    expect(sameStarter(profile.starter, undefined)).toBe(false);
    expect(sameStarter(profile.starter, { kind: 'profile', name: 'Other' })).toBe(false);
    // A profile and a Quick Run are never the same, even with the same name.
    expect(sameStarter(profile.starter, { kind: 'quick_run', id: 'x', name: 'Daily' })).toBe(false);
    expect(sameStarter(quickRun.starter, { kind: 'quick_run', id: 'qr-2', name: 'Nightly' })).toBe(
      false
    );
  });

  describe('workflow nodes', () => {
    const run = { workflowId: 'wf-b', workflowName: 'Workflow', nodeId: 'n1', ancestors: ['wf-a'] };
    const own: HasStarter = { starter: { kind: 'workflow', ...run } };
    const viaQuickRun: HasStarter = {
      starter: { kind: 'quick_run', id: 'qr-1', name: 'Nightly', workflow: run },
    };

    it('finds the node directly or through the Quick Run it ran', () => {
      for (const item of [own, viaQuickRun]) {
        expect(workflowRunOf(item)).toMatchObject(run);
        expect(workflowIdOf(item)).toBe('wf-b');
        expect(isWorkflowNode(item, 'wf-b', 'n1')).toBe(true);
        expect(isWorkflowNode(item, 'wf-b', 'n2')).toBe(false);
        expect(isWorkflowNode(item, 'wf-a', 'n1')).toBe(false);
      }
    });

    it('is neither a profile nor, on its own, a Quick Run', () => {
      expect(profileOf(own)).toBeUndefined();
      expect(quickRunIdOf(own)).toBeUndefined();
      // A Quick Run a node ran keeps its identity.
      expect(quickRunIdOf(viaQuickRun)).toBe('qr-1');
    });

    it('is absent for profiles, standalone Quick Runs and ad hoc work', () => {
      for (const item of [profile, quickRun, adHoc]) {
        expect(workflowRunOf(item)).toBeUndefined();
        expect(workflowIdOf(item)).toBeUndefined();
        expect(isWorkflowNode(item, 'wf-b', 'n1')).toBe(false);
      }
    });

    it('compares nodes by workflow, node and ancestors', () => {
      const same = { kind: 'workflow' as const, ...run, ancestors: [...run.ancestors] };
      expect(sameStarter(own.starter, same)).toBe(true);
      expect(sameStarter(own.starter, { ...same, nodeId: 'n2' })).toBe(false);
      expect(sameStarter(own.starter, { ...same, ancestors: [] })).toBe(false);
      expect(sameStarter(own.starter, quickRun.starter)).toBe(false);
      // The same Quick Run is a different execution once a node started it.
      expect(sameStarter(quickRun.starter, viaQuickRun.starter)).toBe(false);
      expect(
        sameStarter(viaQuickRun.starter, {
          kind: 'quick_run',
          id: 'qr-1',
          name: 'Nightly',
          workflow: { ...run, ancestors: [...run.ancestors] },
        })
      ).toBe(true);
    });
  });
});
