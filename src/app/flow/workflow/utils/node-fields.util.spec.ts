import { describe, it, expect } from 'vitest';
import {
  extractFieldsFromObject,
  getAvailableUpstreamNodes,
  getNodeFields,
  getNodeFieldsForType,
  PREVIOUS_NODE_PSEUDO,
} from './node-fields.util';
import { WorkflowNode } from '../types/workflow.types';

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

  it('returns mount-specific fields for mount node', () => {
    const fields = getNodeFieldsForType('mount');
    expect(fields.map(f => f.key)).toEqual(['mountPoint', 'remote', 'status', 'jobId', 'error']);
  });

  it('returns serve-specific fields for serve node', () => {
    const fields = getNodeFieldsForType('serve');
    expect(fields.map(f => f.key)).toEqual(['addr', 'remote', 'status', 'jobId', 'error']);
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
    it('always prepends PREVIOUS_NODE_PSEUDO even if node list is empty or undefined', () => {
      expect(getAvailableUpstreamNodes(undefined)).toEqual([PREVIOUS_NODE_PSEUDO]);
      expect(getAvailableUpstreamNodes([])).toEqual([PREVIOUS_NODE_PSEUDO]);
    });

    it('filters out current node and includes other upstream nodes', () => {
      const nodes: WorkflowNode[] = [
        {
          id: 'node-1',
          title: 'First Node',
          type: 'check',
          category: 'task',
          x: 0,
          y: 0,
          inputs: [],
          outputs: [],
          config: {},
        },
        {
          id: 'node-2',
          title: 'Current Node',
          type: 'condition',
          category: 'logic',
          x: 100,
          y: 0,
          inputs: [],
          outputs: [],
          config: {},
        },
        {
          id: 'node-3',
          title: 'Third Node',
          type: 'sync',
          category: 'task',
          x: 200,
          y: 0,
          inputs: [],
          outputs: [],
          config: {},
        },
      ];

      const result = getAvailableUpstreamNodes(nodes, 'node-2');
      expect(result.length).toBe(3);
      expect(result[0]).toBe(PREVIOUS_NODE_PSEUDO);
      expect(result[1].id).toBe('node-1');
      expect(result[2].id).toBe('node-3');
      expect(result.some(n => n.id === 'node-2')).toBe(false);
    });
  });
});
