import { WorkflowNode } from '../types/workflow.types';

export interface NodeVariableField {
  key: string;
  label: string;
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

/**
 * Returns available upstream nodes for token interpolation, prepending
 * the virtual `prev` predecessor node and excluding the current node.
 */
export function getAvailableUpstreamNodes(
  nodes: WorkflowNode[] | undefined,
  currentNodeId?: string
): WorkflowNode[] {
  const list: WorkflowNode[] = [PREVIOUS_NODE_PSEUDO];
  if (nodes) {
    list.push(...nodes.filter(n => n.id !== currentNodeId));
  }
  return list;
}

/**
 * Returns available runtime variable fields for a given node type,
 * used in variable picker dropdowns and template token resolution.
 */
export function getNodeFieldsForType(type?: string): NodeVariableField[] {
  switch (type) {
    case 'command':
    case 'exec_script':
      return [
        { key: 'summary', label: 'Summary (summary)' },
        { key: 'output', label: 'Primary Output (output)' },
        { key: 'stdout', label: 'Standard Output (stdout)' },
        { key: 'stderr', label: 'Standard Error (stderr)' },
        { key: 'exitCode', label: 'Exit Code (exitCode)' },
        { key: 'success', label: 'Success (success)' },
        { key: 'status', label: 'Status (status)' },
        { key: 'error', label: 'Error Message (error)' },
      ];
    case 'check':
    case 'cryptcheck':
      return [
        { key: 'summary', label: 'Summary (summary)' },
        { key: 'report', label: 'Markdown Report (report)' },
        { key: 'hasDifferences', label: 'Has Differences (hasDifferences)' },
        { key: 'differCount', label: 'Differ Count (differCount)' },
        { key: 'differ', label: 'Differing Files List (differ)' },
        { key: 'missingOnDstCount', label: 'Missing on Dst Count (missingOnDstCount)' },
        { key: 'missingOnDst', label: 'Missing on Dst List (missingOnDst)' },
        { key: 'missingOnSrcCount', label: 'Missing on Src Count (missingOnSrcCount)' },
        { key: 'missingOnSrc', label: 'Missing on Src List (missingOnSrc)' },
        { key: 'matchCount', label: 'Matched Files Count (matchCount)' },
        { key: 'status', label: 'Status (status)' },
        { key: 'jobId', label: 'Job ID (jobId)' },
        { key: 'error', label: 'Error Message (error)' },
      ];
    case 'sync':
    case 'copy':
    case 'move':
    case 'bisync':
    case 'delete':
    case 'copyurl':
    case 'archivecreate':
      return [
        { key: 'summary', label: 'Summary (summary)' },
        { key: 'bytes', label: 'Bytes Transferred (bytes)' },
        { key: 'bytesFormatted', label: 'Formatted Bytes (bytesFormatted)' },
        { key: 'totalBytes', label: 'Total Bytes (totalBytes)' },
        { key: 'transfers', label: 'Transfers Count (transfers)' },
        { key: 'totalTransfers', label: 'Total Transfers (totalTransfers)' },
        { key: 'errors', label: 'Errors Count (errors)' },
        { key: 'speedFormatted', label: 'Speed (speedFormatted)' },
        { key: 'status', label: 'Status (status)' },
        { key: 'jobId', label: 'Job ID (jobId)' },
        { key: 'error', label: 'Error Message (error)' },
      ];
    case 'mount':
      return [
        { key: 'mountPoint', label: 'Mount Point Path (mountPoint)' },
        { key: 'remote', label: 'Remote Name (remote)' },
        { key: 'status', label: 'Mount Status (status)' },
        { key: 'jobId', label: 'Job ID (jobId)' },
        { key: 'error', label: 'Error Message (error)' },
      ];
    case 'serve':
      return [
        { key: 'addr', label: 'Server Address (addr)' },
        { key: 'remote', label: 'Remote Name (remote)' },
        { key: 'status', label: 'Server Status (status)' },
        { key: 'jobId', label: 'Job ID (jobId)' },
        { key: 'error', label: 'Error Message (error)' },
      ];
    case 'condition':
      return [
        { key: 'conditionMet', label: 'Condition Met (conditionMet)' },
        { key: 'branch', label: 'Selected Branch (branch)' },
      ];
    case 'rc_command':
      return [
        { key: 'command', label: 'Command (command)' },
        { key: 'status', label: 'Status (status)' },
        { key: 'success', label: 'Success (success)' },
        { key: 'summary', label: 'Summary (summary)' },
        { key: 'result', label: 'Command Result (result)' },
        { key: 'json', label: 'Formatted JSON (json)' },
        { key: 'error', label: 'Error Message (error)' },
      ];
    default:
      return [
        { key: 'status', label: 'Status (status)' },
        { key: 'summary', label: 'Summary (summary)' },
        { key: 'jobId', label: 'Job ID (jobId)' },
        { key: 'error', label: 'Error Message (error)' },
      ];
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
