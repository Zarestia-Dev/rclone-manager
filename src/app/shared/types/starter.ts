/** The workflow node that started the work; `ancestors` are the workflows that led to it. */
export interface WorkflowRun {
  workflowId: string;
  workflowName: string;
  nodeId: string;
  ancestors: string[];
}

/**
 * What started a job, mount or serve: a profile, a Quick Run or a workflow node, never two of
 * them. A workflow node can run a Quick Run, which is the only case that names both.
 * Work that comes from none of them (a file manager action, an update) has no starter.
 */
export type Starter =
  | { kind: 'profile'; name: string }
  | { kind: 'quick_run'; id: string; name: string; workflow?: WorkflowRun }
  | ({ kind: 'workflow' } & WorkflowRun);

export interface HasStarter {
  starter?: Starter;
}

/** The name of the profile that started the item; undefined for anything else. */
export function profileOf(item: HasStarter): string | undefined {
  return item.starter?.kind === 'profile' ? item.starter.name : undefined;
}

/** The id of the Quick Run that started the item; undefined for anything else. */
export function quickRunIdOf(item: HasStarter): string | undefined {
  return item.starter?.kind === 'quick_run' ? item.starter.id : undefined;
}

/** The name of the Quick Run that started the item; undefined for anything else. */
export function quickRunNameOf(item: HasStarter): string | undefined {
  return item.starter?.kind === 'quick_run' ? item.starter.name : undefined;
}

/** The workflow node that started the item, directly or by running a Quick Run. */
export function workflowRunOf(item: HasStarter): WorkflowRun | undefined {
  const starter = item.starter;
  if (starter?.kind === 'workflow') return starter;
  return starter?.kind === 'quick_run' ? starter.workflow : undefined;
}

/** The id of the workflow that started the item. */
export function workflowIdOf(item: HasStarter): string | undefined {
  return workflowRunOf(item)?.workflowId;
}

/** Whether the given node of the given workflow started the item. */
export function isWorkflowNode(item: HasStarter, workflowId: string, nodeId: string): boolean {
  const run = workflowRunOf(item);
  return run?.workflowId === workflowId && run.nodeId === nodeId;
}

function sameRun(a?: WorkflowRun, b?: WorkflowRun): boolean {
  if (!a || !b) return a === b;
  return (
    a.workflowId === b.workflowId &&
    a.workflowName === b.workflowName &&
    a.nodeId === b.nodeId &&
    a.ancestors.length === b.ancestors.length &&
    a.ancestors.every((id, i) => id === b.ancestors[i])
  );
}

/** Whether two starters are the same profile, Quick Run or workflow node. */
export function sameStarter(a?: Starter, b?: Starter): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  switch (a.kind) {
    case 'profile':
      return b.kind === 'profile' && a.name === b.name;
    case 'quick_run':
      return (
        b.kind === 'quick_run' &&
        a.id === b.id &&
        a.name === b.name &&
        sameRun(a.workflow, b.workflow)
      );
    case 'workflow':
      return b.kind === 'workflow' && sameRun(a, b);
  }
}
