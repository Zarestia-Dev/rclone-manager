import { WorkflowDefinition, WorkflowNode } from '../types/workflow.types';

/** Run results shown on a node; they describe a run, not the workflow, and are never stored. */
const RUNTIME_NODE_FIELDS = [
  'state',
  'errorMessage',
  'lastDurationMs',
  'lastOutput',
  'startedAt',
  'finishedAt',
] as const satisfies readonly (keyof WorkflowNode)[];

/** The node as stored: its definition without what the last run left on it. */
export function toPersistableNode(node: WorkflowNode): WorkflowNode {
  const persisted = { ...node };
  for (const field of RUNTIME_NODE_FIELDS) {
    delete persisted[field];
  }
  return persisted;
}

/** The workflow as stored or sent to the backend, without any node's run results. */
export function toPersistableWorkflow(workflow: WorkflowDefinition): WorkflowDefinition {
  return { ...workflow, nodes: workflow.nodes.map(toPersistableNode) };
}

/** Carries the run results of `from` over to the matching nodes of `to`, by node id. */
export function withRuntimeFields(
  to: readonly WorkflowNode[],
  from: readonly WorkflowNode[]
): WorkflowNode[] {
  const runtime = new Map(from.map(node => [node.id, node]));
  return to.map(node => {
    const source = runtime.get(node.id);
    if (!source) return node;
    const merged = { ...node };
    for (const field of RUNTIME_NODE_FIELDS) {
      if (source[field] === undefined) delete merged[field];
      else (merged as Record<string, unknown>)[field] = source[field];
    }
    return merged;
  });
}
