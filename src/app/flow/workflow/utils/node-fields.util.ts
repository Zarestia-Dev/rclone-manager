import { WorkflowDefinition, WorkflowNode } from '../types/workflow.types';

export interface NodeVariableField {
  key: string;
  labelKey?: string;
  label?: string;
}

function createTokenFields(keys: string[]): NodeVariableField[] {
  return keys.map(key => ({
    key,
    labelKey: `flow.workflow.tokens.fields.${key}`,
  }));
}

/**
 * Synthetic predecessor node representing whatever node precedes the current node in the DAG.
 */
export const PREVIOUS_NODE_PSEUDO: WorkflowNode = {
  id: 'prev',
  title: 'Previous Node',
  titleKey: 'flow.workflow.tokens.prevNode',
  type: 'prev',
  category: 'action',
  x: 0,
  y: 0,
  inputs: [],
  outputs: [],
  config: {},
};

/** The nodes a path of wires leads from into `nodeId`: the only ones whose output is there when it runs. */
function getAncestors(
  workflow: Pick<WorkflowDefinition, 'nodes' | 'edges'> | null | undefined,
  nodeId: string | undefined
): WorkflowNode[] {
  if (!workflow || !nodeId) return [];
  const sources = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    sources.set(edge.targetNodeId, [...(sources.get(edge.targetNodeId) ?? []), edge.sourceNodeId]);
  }
  const seen = new Set<string>();
  const pending = [nodeId];
  while (pending.length > 0) {
    for (const source of sources.get(pending.pop() as string) ?? []) {
      if (source === nodeId || seen.has(source)) continue;
      seen.add(source);
      pending.push(source);
    }
  }
  return workflow.nodes.filter(n => seen.has(n.id));
}

/**
 * Returns the nodes whose output a node can use in tokens: the virtual `prev` predecessor,
 * then every node that leads into it.
 */
export function getAvailableUpstreamNodes(
  workflow: Pick<WorkflowDefinition, 'nodes' | 'edges'> | null | undefined,
  currentNodeId?: string
): WorkflowNode[] {
  return [PREVIOUS_NODE_PSEUDO, ...getAncestors(workflow, currentNodeId)];
}

/** The node whose output reaches `nodeId` first (its first incoming wire): what `prev` refers to. */
export function getPreviousNode(
  workflow: Pick<WorkflowDefinition, 'nodes' | 'edges'> | null | undefined,
  nodeId: string
): WorkflowNode | undefined {
  const edge = workflow?.edges.find(e => e.targetNodeId === nodeId);
  return edge ? workflow?.nodes.find(n => n.id === edge.sourceNodeId) : undefined;
}

/** Fields `prev` offers for a node: those of the node before it, else the generic ones. */
export function getPreviousNodeFields(
  workflow: Pick<WorkflowDefinition, 'nodes' | 'edges'> | null | undefined,
  nodeId: string
): NodeVariableField[] {
  const previous = getPreviousNode(workflow, nodeId);
  return previous ? getNodeFields(previous) : getNodeFieldsForType('prev');
}

/**
 * Returns available runtime variable fields for a given node type,
 * used in variable picker dropdowns and template token resolution.
 */
export function getNodeFieldsForType(type?: string): NodeVariableField[] {
  switch (type) {
    case 'command':
    case 'exec_script':
      return createTokenFields([
        'summary',
        'output',
        'stdout',
        'stderr',
        'exitCode',
        'success',
        'status',
        'error',
      ]);
    case 'check':
    case 'cryptcheck':
      return createTokenFields([
        'summary',
        'report',
        'hasDifferences',
        'differCount',
        'differ',
        'missingOnDstCount',
        'missingOnDst',
        'missingOnSrcCount',
        'missingOnSrc',
        'matchCount',
        'status',
        'jobId',
        'error',
      ]);
    case 'sync':
    case 'copy':
    case 'move':
      return [...getNodeFieldsForType('bisync'), ...createTokenFields(['reportCounts', 'reports'])];
    case 'bisync':
    case 'delete':
    case 'index':
    case 'copyurl':
    case 'archivecreate':
      return createTokenFields([
        'summary',
        'bytes',
        'bytesFormatted',
        'totalBytes',
        'transfers',
        'totalTransfers',
        'errors',
        'speedFormatted',
        'status',
        'jobId',
        'error',
      ]);
    // Mounting and serving start no job to follow, so there is no `jobId`.
    case 'mount':
      return createTokenFields(['mountPoint', 'remote', 'status', 'error']);
    case 'serve':
      return createTokenFields(['addr', 'remote', 'status', 'error']);
    case 'condition':
      return createTokenFields(['conditionMet', 'branch']);
    case 'schedule_wait':
      return createTokenFields([
        'cronExpression',
        'targetTime',
        'waitedSeconds',
        'resumedAt',
        'status',
      ]);
    case 'rc_command':
      return createTokenFields([
        'command',
        'status',
        'success',
        'summary',
        'result',
        'json',
        'error',
      ]);
    case 'prev':
      return createTokenFields([
        'summary',
        'status',
        'success',
        'result',
        'report',
        'hasDifferences',
        'differ',
        'differCount',
        'bytesFormatted',
        'transfers',
        'output',
        'exitCode',
        'stdout',
        'stderr',
        'jobId',
        'error',
      ]);
    default:
      return createTokenFields(['status', 'summary', 'jobId', 'error']);
  }
}

/**
 * Recursively extracts variable fields from a sample or live JSON object
 * up to a specified depth (default 2), allowing users to pick nested keys.
 */
export function extractFieldsFromObject(
  obj: unknown,
  prefix = '',
  depth = 0,
  maxDepth = 2
): NodeVariableField[] {
  if (depth > maxDepth || !obj || typeof obj !== 'object') {
    return [];
  }

  const fields: NodeVariableField[] = [];

  if (Array.isArray(obj)) {
    const key = prefix ? `${prefix}.length` : 'length';
    fields.push({ key, label: `${key} (array length)` });
    if (obj.length > 0 && typeof obj[0] === 'object') {
      fields.push(...extractFieldsFromObject(obj[0], `${prefix}[0]`, depth + 1, maxDepth));
    }
    return fields;
  }

  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') {
      fields.push({ key: fullKey, label: `${fullKey} (object)` });
      fields.push(...extractFieldsFromObject(v, fullKey, depth + 1, maxDepth));
    } else {
      fields.push({ key: fullKey, label: `${fullKey} (${typeof v})` });
    }
  }

  return fields;
}

/**
 * Returns available fields for a workflow node, merging static schema fields
 * with dynamic fields extracted from `sampleOutput` config or `lastOutput` runtime data.
 */
export function getNodeFields(node: {
  type?: string;
  config?: Record<string, unknown>;
  lastOutput?: unknown;
}): NodeVariableField[] {
  const staticFields = getNodeFieldsForType(node.type);
  const staticKeys = new Set(staticFields.map(f => f.key));

  let dynamicData: unknown = node.lastOutput;
  if (!dynamicData && node.config?.['sampleOutput']) {
    try {
      const sample = node.config['sampleOutput'];
      dynamicData = typeof sample === 'string' ? JSON.parse(sample) : sample;
    } catch {
      // Ignore invalid JSON sample
    }
  }

  if (!dynamicData) {
    return staticFields;
  }

  const dynamicFields = extractFieldsFromObject(dynamicData);
  const result = [...staticFields];

  for (const df of dynamicFields) {
    if (!staticKeys.has(df.key)) {
      result.push(df);
      staticKeys.add(df.key);
    }
  }

  return result;
}
