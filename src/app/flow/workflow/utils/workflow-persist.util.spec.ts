import { describe, it, expect } from 'vitest';
import { WorkflowDefinition, WorkflowNode } from '../types/workflow.types';
import { toPersistableWorkflow, withRuntimeFields } from './workflow-persist.util';

const node = (id: string, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id,
  type: 'delay',
  category: 'logic',
  title: id,
  x: 0,
  y: 0,
  inputs: [],
  outputs: [],
  config: { delaySeconds: 5 },
  ...extra,
});

describe('workflow persistence helpers', () => {
  it('drops the results of a run from every node and keeps the definition', () => {
    const workflow: WorkflowDefinition = {
      id: 'wf',
      name: 'Flow',
      showOnTray: false,
      viewport: { x: 0, y: 0, zoom: 1 },
      edges: [],
      nodes: [
        node('a', {
          state: 'failed',
          errorMessage: 'boom',
          lastDurationMs: 12,
          lastOutput: { differ: ['x'] },
          startedAt: 't0',
          finishedAt: 't1',
        }),
      ],
    };

    const persisted = toPersistableWorkflow(workflow);

    expect(persisted.nodes[0]).toEqual(node('a'));
    expect('lastOutput' in persisted.nodes[0]).toBe(false);
    // The workflow being edited keeps its results.
    expect(workflow.nodes[0].lastOutput).toEqual({ differ: ['x'] });
  });

  it('restores the results of a run onto the matching nodes only', () => {
    const current = [node('a', { state: 'success', lastOutput: { ok: true } }), node('b')];
    const restored = withRuntimeFields(
      [node('a', { config: { delaySeconds: 1 } }), node('c', { state: 'idle' })],
      current
    );

    expect(restored[0].config).toEqual({ delaySeconds: 1 });
    expect(restored[0].state).toBe('success');
    expect(restored[0].lastOutput).toEqual({ ok: true });
    expect(restored[1].state).toBe('idle');
  });

  it('clears a result the current node no longer has', () => {
    const restored = withRuntimeFields([node('a', { state: 'failed' })], [node('a')]);
    expect(restored[0].state).toBeUndefined();
  });
});
