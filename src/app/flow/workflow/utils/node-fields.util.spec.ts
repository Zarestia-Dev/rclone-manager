import { describe, it, expect } from 'vitest';
import {
  extractFieldsFromObject,
  getAvailableUpstreamNodes,
  getNodeFields,
  getNodeFieldsForType,
  PREVIOUS_NODE_PSEUDO,
} from './node-fields.util';
import { WorkflowEdge, WorkflowNode } from '../types/workflow.types';

describe('node-fields.util', () => {
  it('returns stdout, exitCode, success, stderr, summary, output for script and command nodes', () => {
    const cmdFields = getNodeFieldsForType('command');
    expect(cmdFields.map(f => f.key)).toContain('summary');
    expect(cmdFields.map(f => f.key)).toContain('output');
    expect(cmdFields.map(f => f.key)).toContain('stdout');
    expect(cmdFields.map(f => f.key)).toContain('stderr');
    expect(cmdFields.map(f => f.key)).toContain('exitCode');
    expect(cmdFields.map(f => f.key)).toContain('success');

    const scriptFields = getNodeFieldsForType('exec_script');
    expect(scriptFields.map(f => f.key)).toContain('stdout');
    expect(scriptFields.map(f => f.key)).toContain('exitCode');
  });

  it('returns check-specific fields including report, hasDifferences, differ for check node', () => {
    const checkFields = getNodeFieldsForType('check');
    const keys = checkFields.map(f => f.key);
    expect(keys).toContain('summary');
    expect(keys).toContain('report');
    expect(keys).toContain('hasDifferences');
    expect(keys).toContain('differCount');
    expect(keys).toContain('differ');
    expect(keys).toContain('missingOnDstCount');
    expect(keys).toContain('missingOnSrcCount');
    expect(keys).toContain('matchCount');
    expect(keys).toContain('status');
  });

  it('returns transfer fields for sync, copy, move, etc.', () => {
    for (const type of ['sync', 'copy', 'move', 'bisync', 'delete', 'copyurl', 'archivecreate']) {
      const fields = getNodeFieldsForType(type);
      const keys = fields.map(f => f.key);
      expect(keys).toContain('summary');
      expect(keys).toContain('bytes');
      expect(keys).toContain('bytesFormatted');
      expect(keys).toContain('totalBytes');
      expect(keys).toContain('transfers');
      expect(keys).toContain('errors');
      expect(keys).toContain('status');
    }
  });

  it('adds the file reports only to the nodes whose jobs can return them', () => {
    for (const type of ['sync', 'copy', 'move']) {
      const keys = getNodeFieldsForType(type).map(f => f.key);
      expect(keys).toContain('reportCounts');
      expect(keys).toContain('reports');
      expect(keys.filter(key => key === 'summary')).toHaveLength(1);
    }
    for (const type of ['bisync', 'delete', 'copyurl', 'archivecreate', 'check']) {
      const keys = getNodeFieldsForType(type).map(f => f.key);
      expect(keys).not.toContain('reportCounts');
      expect(keys).not.toContain('reports');
    }
  });

  it('returns mount-specific fields for mount node', () => {
    const fields = getNodeFieldsForType('mount');
    expect(fields.map(f => f.key)).toEqual(['mountPoint', 'remote', 'status', 'error']);
  });

  it('returns serve-specific fields for serve node', () => {
    const fields = getNodeFieldsForType('serve');
    expect(fields.map(f => f.key)).toEqual(['addr', 'remote', 'status', 'error']);
  });

  it('returns condition-specific fields for condition node', () => {
    const fields = getNodeFieldsForType('condition');
    expect(fields.map(f => f.key)).toEqual(['conditionMet', 'branch']);
  });

  it('returns rc_command-specific fields for rc_command node', () => {
    const fields = getNodeFieldsForType('rc_command');
    const keys = fields.map(f => f.key);
    expect(keys).toContain('command');
    expect(keys).toContain('status');
    expect(keys).toContain('success');
    expect(keys).toContain('result');
    expect(keys).toContain('json');
  });

  it('returns fallback status/summary/jobId/error fields for unknown or undefined type', () => {
    const fieldsUnknown = getNodeFieldsForType('unknown_type');
    expect(fieldsUnknown.map(f => f.key)).toEqual(['status', 'summary', 'jobId', 'error']);

    const fieldsUndefined = getNodeFieldsForType(undefined);
    expect(fieldsUndefined.map(f => f.key)).toEqual(['status', 'summary', 'jobId', 'error']);
  });

  it('assigns structured labelKey for all static fields matching flow.workflow.tokens.fields.<key>', () => {
    const fields = getNodeFieldsForType('command');
    for (const f of fields) {
      expect(f.labelKey).toBe(`flow.workflow.tokens.fields.${f.key}`);
    }
  });

  it('returns comprehensive predecessor fields for prev type', () => {
    const prevFields = getNodeFieldsForType('prev');
    const keys = prevFields.map(f => f.key);
    expect(keys).toContain('summary');
    expect(keys).toContain('status');
    expect(keys).toContain('success');
    expect(keys).toContain('stdout');
    expect(keys).toContain('stderr');
    expect(keys).toContain('exitCode');
    expect(keys).toContain('bytesFormatted');
    expect(keys).toContain('transfers');
    expect(keys).toContain('report');
    expect(keys).toContain('hasDifferences');
    expect(keys).toContain('differ');
    expect(keys).toContain('differCount');
    expect(keys).toContain('error');
    for (const f of prevFields) {
      expect(f.labelKey).toBe(`flow.workflow.tokens.fields.${f.key}`);
    }
  });

  describe('extractFieldsFromObject', () => {
    it('extracts top-level and nested fields from objects and arrays', () => {
      const sample = {
        name: 'test',
        count: 5,
        nested: {
          active: true,
        },
        items: ['a', 'b'],
      };
      const fields = extractFieldsFromObject(sample);
      const keys = fields.map(f => f.key);
      expect(keys).toContain('name');
      expect(keys).toContain('count');
      expect(keys).toContain('nested');
      expect(keys).toContain('nested.active');
      expect(keys).toContain('items.length');
    });

    it('returns empty array for non-objects or exceeded depth', () => {
      expect(extractFieldsFromObject(null)).toEqual([]);
      expect(extractFieldsFromObject('string')).toEqual([]);
      expect(extractFieldsFromObject({ a: 1 }, '', 3, 2)).toEqual([]);
    });
  });

  describe('getNodeFields', () => {
    it('merges dynamic fields from sampleOutput JSON into node fields', () => {
      const node = {
        type: 'rc_command',
        config: {
          sampleOutput: JSON.stringify({ diskUsage: '100GB', nestedStat: { active: true } }),
        },
      };
      const fields = getNodeFields(node);
      const keys = fields.map(f => f.key);
      expect(keys).toContain('command');
      expect(keys).toContain('result');
      expect(keys).toContain('diskUsage');
      expect(keys).toContain('nestedStat.active');
    });

    it('prefers lastOutput over sampleOutput when available', () => {
      const node = {
        type: 'rc_command',
        config: {
          sampleOutput: JSON.stringify({ oldKey: 'val' }),
        },
        lastOutput: {
          liveKey: 42,
        },
      };
      const fields = getNodeFields(node);
      const keys = fields.map(f => f.key);
      expect(keys).toContain('liveKey');
      expect(keys).not.toContain('oldKey');
    });
  });

  describe('getAvailableUpstreamNodes', () => {
    it('defines titleKey on PREVIOUS_NODE_PSEUDO for dynamic localization', () => {
      expect(PREVIOUS_NODE_PSEUDO.titleKey).toBe('flow.workflow.tokens.prevNode');
    });

    it('always prepends PREVIOUS_NODE_PSEUDO even if there is no workflow', () => {
      expect(getAvailableUpstreamNodes(undefined)).toEqual([PREVIOUS_NODE_PSEUDO]);
      expect(getAvailableUpstreamNodes({ nodes: [], edges: [] }, 'x')).toEqual([
        PREVIOUS_NODE_PSEUDO,
      ]);
    });

    const node = (id: string): WorkflowNode => ({
      id,
      title: id,
      type: 'sync',
      category: 'task',
      x: 0,
      y: 0,
      inputs: [],
      outputs: [],
      config: {},
    });
    const wire = (from: string, to: string): WorkflowEdge => ({
      id: `${from}-${to}`,
      sourceNodeId: from,
      sourcePortId: 'success',
      targetNodeId: to,
      targetPortId: 'in',
    });

    it('offers only the nodes that lead into the current one, near or far', () => {
      // a -> b -> current; c is unconnected and d comes after current
      const workflow = {
        nodes: ['a', 'b', 'c', 'current', 'd'].map(node),
        edges: [wire('a', 'b'), wire('b', 'current'), wire('current', 'd')],
      };

      const result = getAvailableUpstreamNodes(workflow, 'current');

      expect(result[0]).toBe(PREVIOUS_NODE_PSEUDO);
      expect(result.slice(1).map(n => n.id)).toEqual(['a', 'b']);
    });

    it('lists a node once when several paths lead from it, and survives a loop', () => {
      const workflow = {
        nodes: ['a', 'b', 'c', 'current'].map(node),
        edges: [
          wire('a', 'b'),
          wire('a', 'c'),
          wire('b', 'current'),
          wire('c', 'current'),
          wire('current', 'a'),
        ],
      };

      expect(
        getAvailableUpstreamNodes(workflow, 'current')
          .slice(1)
          .map(n => n.id)
      ).toEqual(['a', 'b', 'c']);
    });

    it('offers nothing but prev without a current node', () => {
      expect(getAvailableUpstreamNodes({ nodes: [node('a')], edges: [] })).toEqual([
        PREVIOUS_NODE_PSEUDO,
      ]);
    });
  });
});
