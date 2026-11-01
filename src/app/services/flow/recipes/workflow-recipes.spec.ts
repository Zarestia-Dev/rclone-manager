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
});
