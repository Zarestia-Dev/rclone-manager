import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILTIN_WORKFLOW_TEMPLATES } from './workflow-recipes';

const english = JSON.parse(readFileSync('resources/i18n/en-US/main.json', 'utf-8')) as unknown;

function hasKey(key: string): boolean {
  let current: unknown = english;
  for (const part of key.split('.')) {
    if (typeof current !== 'object' || current === null || !(part in current)) return false;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string';
}

describe('BUILTIN_WORKFLOW_TEMPLATES', () => {
  it('only refers to translation keys that exist', () => {
    const keys = BUILTIN_WORKFLOW_TEMPLATES.flatMap(template => [
      template.nameKey,
      template.descriptionKey,
      ...template.definition.nodes.flatMap(node => [
        node.titleKey,
        ...[...(node.inputs ?? []), ...(node.outputs ?? [])].map(port => port.labelKey),
      ]),
    ]).filter((key): key is string => !!key);

    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter(key => !hasKey(key))).toEqual([]);
  });

  const templates = BUILTIN_WORKFLOW_TEMPLATES.map(template => [template.id, template] as const);

  describe.each(templates)('%s', (_id, template) => {
    const { nodes, edges } = template.definition;
    const node = (id: string): (typeof nodes)[number] | undefined => nodes.find(n => n.id === id);

    it('connects edges to ports its nodes have', () => {
      for (const edge of edges) {
        const source = node(edge.sourceNodeId);
        const target = node(edge.targetNodeId);
        expect(source, `${edge.id}: source node`).toBeDefined();
        expect(target, `${edge.id}: target node`).toBeDefined();
        expect(
          source?.outputs.some(port => port.id === edge.sourcePortId),
          `${edge.id}: ${edge.sourceNodeId} has no output ${edge.sourcePortId}`
        ).toBe(true);
        expect(
          target?.inputs.some(port => port.id === edge.targetPortId),
          `${edge.id}: ${edge.targetNodeId} has no input ${edge.targetPortId}`
        ).toBe(true);
      }
    });

    it('keeps nodes in the same order as their connections', () => {
      const nodeOrder = new Map(nodes.map((workflowNode, index) => [workflowNode.id, index]));

      for (const edge of edges) {
        const source = nodeOrder.get(edge.sourceNodeId);
        const target = nodeOrder.get(edge.targetNodeId);
        expect(source, `${edge.id}: source node`).toBeDefined();
        expect(target, `${edge.id}: target node`).toBeDefined();
        expect(source ?? Infinity, `${edge.id}: source node order`).toBeLessThan(
          target ?? -Infinity
        );
      }
    });

    it('only asks for notification severities the notification form offers', () => {
      const offered = ['info', 'warning', 'average', 'high', 'critical'];
      for (const n of nodes.filter(n => n.type === 'notification')) {
        expect(offered, n.id).toContain(n.config['severity']);
      }
    });

    it('does not read `prev` right after a condition, which is then the previous node', () => {
      for (const n of nodes.filter(n => JSON.stringify(n.config).includes('{{prev.'))) {
        const sources = edges.filter(e => e.targetNodeId === n.id).map(e => node(e.sourceNodeId));
        expect(
          sources.filter(source => source?.category === 'logic').map(source => source?.id),
          `${n.id} reads prev after a logic node; name the node it means with nodes.<id>`
        ).toEqual([]);
      }
    });

    it('refers to nodes that exist when it names one in a template', () => {
      const named = [...JSON.stringify(nodes).matchAll(/\{\{nodes\.([^.}]+)\./g)].map(m => m[1]);
      for (const id of named) expect(node(id), `{{nodes.${id}}}`).toBeDefined();
    });

    it('follows a check on its failure port too, as rclone fails a check that finds differences', () => {
      for (const n of nodes.filter(n => n.type === 'check')) {
        const used = edges.filter(e => e.sourceNodeId === n.id).map(e => e.sourcePortId);
        expect(used, n.id).toContain('failure');
      }
    });
  });
});
